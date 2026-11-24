import { DisconnectReason } from '../Types'
import type { ILogger } from './logger'

/** Codes that mean "this session will never work again: stop and pair again" */
export const FATAL_DISCONNECT_CODES: ReadonlySet<number> = new Set([
	DisconnectReason.loggedOut, // 401
	DisconnectReason.forbidden, // 403
	DisconnectReason.multideviceMismatch // 411
])

/** Codes that can be caused by an outdated WhatsApp Web version */
export const STALE_VERSION_CODES: ReadonlySet<number> = new Set([DisconnectReason.connectionLost, DisconnectReason.timedOut])

export type ReconnectContext = {
	/** 0 for the first connect, then 1, 2, 3… */
	attempt: number
	/** status code of the disconnect that caused this connect, if any */
	statusCode?: number
	/** version returned by `versionProvider`, when one was fetched */
	version?: [number, number, number]
}

type MinimalSocket = {
	ev: { on: (event: 'connection.update', listener: (update: any) => void) => void }
}

export type ReconnectManagerOptions<S extends MinimalSocket> = {
	/** builds a new socket; called for the first connect and for every reconnect */
	connect: (context: ReconnectContext) => S | Promise<S>
	/** runs for every socket the manager creates; attach your event handlers here */
	onSocket?: (socket: S, context: ReconnectContext) => void | Promise<void>
	/** return false to stop reconnecting; default refuses logged out / forbidden / mismatch */
	shouldReconnect?: (statusCode: number | undefined, context: ReconnectContext) => boolean
	/** called before a reconnect after a 408; its result is handed to `connect` */
	versionProvider?: () => Promise<[number, number, number] | undefined>
	/** called once when the manager stops retrying */
	onGiveUp?: (statusCode: number | undefined, error: unknown) => void
	maxRetries?: number
	baseDelayMs?: number
	maxDelayMs?: number
	/** 0 to 1; share of the delay that is randomised so many bots do not reconnect together */
	jitter?: number
	/** delay after 515 (restart required), which WhatsApp sends on purpose after pairing */
	restartRequiredDelayMs?: number
	logger?: ILogger
}

export const shouldReconnectByDefault = (statusCode: number | undefined) =>
	statusCode === undefined || !FATAL_DISCONNECT_CODES.has(statusCode)

/** Exponential backoff with jitter: about 1s, 2s, 4s… capped at maxDelayMs */
export const computeBackoff = ({
	attempt,
	baseDelayMs = 1000,
	maxDelayMs = 30_000,
	jitter = 0.3,
	random = Math.random
}: {
	attempt: number
	baseDelayMs?: number
	maxDelayMs?: number
	jitter?: number
	random?: () => number
}) => {
	const exponential = Math.min(baseDelayMs * 2 ** Math.max(0, attempt - 1), maxDelayMs)
	if (!jitter) {
		return Math.round(exponential)
	}

	const factor = 1 - jitter + random() * jitter
	return Math.max(1, Math.round(exponential * factor))
}

/**
 * Baileys does not reconnect for you. This manager owns only the reconnect
 * policy: backoff between attempts, no reconnect on a logged-out session,
 * never two sockets at once, and a fresh WhatsApp Web version after a 408.
 * You still build the socket yourself in `connect`.
 */
export const createReconnectManager = <S extends MinimalSocket>({
	connect,
	onSocket,
	shouldReconnect = shouldReconnectByDefault,
	versionProvider,
	onGiveUp,
	maxRetries = Infinity,
	baseDelayMs = 1000,
	maxDelayMs = 30_000,
	jitter = 0.3,
	restartRequiredDelayMs = 500,
	logger
}: ReconnectManagerOptions<S>) => {
	if (typeof connect !== 'function') {
		throw new TypeError('createReconnectManager: connect() is required')
	}

	let attempt = 0
	let stopped = false
	let starting = false
	let currentSocket: S | undefined
	let reconnectTimer: NodeJS.Timeout | undefined
	let lastVersion: [number, number, number] | undefined

	const clearTimer = () => {
		if (reconnectTimer) {
			clearTimeout(reconnectTimer)
			reconnectTimer = undefined
		}
	}

	const onClose = async (socket: S, statusCode: number | undefined, error: unknown) => {
		// a close from a socket that was already replaced is not ours to handle
		if (stopped || socket !== currentSocket || reconnectTimer) {
			return
		}

		const context: ReconnectContext = { attempt, statusCode, version: lastVersion }
		if (!shouldReconnect(statusCode, context)) {
			logger?.warn({ statusCode }, 'not reconnecting: this disconnect is final')
			onGiveUp?.(statusCode, error)
			return
		}

		if (attempt >= maxRetries) {
			logger?.error({ statusCode, attempt }, 'not reconnecting: retry limit reached')
			onGiveUp?.(statusCode, error)
			return
		}

		attempt += 1
		const delay =
			statusCode === DisconnectReason.restartRequired
				? restartRequiredDelayMs
				: computeBackoff({ attempt, baseDelayMs, maxDelayMs, jitter })
		logger?.info({ statusCode, attempt, delay }, 'reconnecting')

		reconnectTimer = setTimeout(async () => {
			reconnectTimer = undefined
			if (versionProvider && statusCode !== undefined && STALE_VERSION_CODES.has(statusCode)) {
				try {
					// a failed fetch keeps the last known good version
					lastVersion = (await versionProvider()) || lastVersion
				} catch (err) {
					logger?.warn({ err }, 'could not refresh the WhatsApp Web version; keeping the current one')
				}
			}

			void run(statusCode)
		}, delay)
	}

	const run = async (statusCode?: number): Promise<S | undefined> => {
		if (stopped || starting) {
			return currentSocket
		}

		starting = true
		const context: ReconnectContext = { attempt, statusCode, version: lastVersion }
		try {
			const socket = await connect(context)
			currentSocket = socket
			socket.ev.on('connection.update', update => {
				if (update?.connection === 'open' && socket === currentSocket) {
					attempt = 0
				} else if (update?.connection === 'close') {
					const error = update?.lastDisconnect?.error
					void onClose(socket, error?.output?.statusCode, error)
				}
			})
			await onSocket?.(socket, context)
			return socket
		} catch (error) {
			logger?.error({ err: error }, 'connect() failed')
			starting = false
			// treat a connect() that throws like a lost connection
			currentSocket = undefined
			if (!stopped) {
				if (attempt >= maxRetries) {
					onGiveUp?.(undefined, error)
				} else {
					attempt += 1
					reconnectTimer = setTimeout(
						() => {
							reconnectTimer = undefined
							void run(statusCode)
						},
						computeBackoff({ attempt, baseDelayMs, maxDelayMs, jitter })
					)
				}
			}

			return undefined
		} finally {
			starting = false
		}
	}

	return {
		/** connect for the first time */
		start: () => {
			stopped = false
			return run()
		},
		/** stop reconnecting; the current socket is left for you to close */
		stop: () => {
			stopped = true
			clearTimer()
		},
		get socket() {
			return currentSocket
		},
		get attempt() {
			return attempt
		}
	}
}
