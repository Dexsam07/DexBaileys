import { Boom } from '@hapi/boom'
import { promises as fs } from 'fs'
import { dirname } from 'path'
import { proto } from '../../WAProto/index.js'
import type { AnyMessageContent, MiscMessageGenerationOptions, WAMessage, WAMessageKey, WAVersion } from '../Types'
import { isLidUser, isPnUser, jidDecode, jidNormalizedUser } from '../WABinary'

/** WhatsApp shows at most this many sticker reactions on one message */
export const MAX_STICKER_REACTIONS = 30

/** Wrap an uploaded sticker so that it is attached to `key` as a sticker reaction */
export const buildStickerReaction = (sticker: proto.Message.IStickerMessage, key: WAMessageKey): proto.IMessage => {
	if (!key?.remoteJid || !key.id) {
		throw new Boom('sticker reaction needs the key of the message to react to', { statusCode: 400 })
	}

	if (!sticker?.mediaKey || !(sticker.url || sticker.directPath)) {
		throw new Boom('sticker reaction needs an uploaded sticker', { statusCode: 400 })
	}

	return {
		stickerMessage: { ...sticker, isAnimated: !!sticker.isAnimated },
		messageContextInfo: {
			messageAssociation: {
				associationType: proto.MessageAssociation.AssociationType.STICKER_ANNOTATION,
				parentMessageKey: {
					remoteJid: key.remoteJid,
					fromMe: !!key.fromMe,
					id: key.id,
					...(key.participant ? { participant: key.participant } : {})
				}
			}
		}
	}
}

export type JidLookup = {
	getLIDForPN: (pn: string) => Promise<string | null>
	getPNForLID: (lid: string) => Promise<string | null>
}

const userOf = (jid: string | null | undefined) => (jid ? jidDecode(jidNormalizedUser(jid))?.user : undefined)

const toJid = (value: string): string => {
	const trimmed = String(value || '').trim()
	if (!trimmed) return ''
	if (trimmed.includes('@')) return jidNormalizedUser(trimmed)
	const digits = trimmed.replace(/\D/g, '')
	return digits ? `${digits}@s.whatsapp.net` : ''
}

/** Phone-number JID and LID of one user, as far as the local mapping knows them */
export const resolveUserJids = async (jid: string, lookup: JidLookup): Promise<{ pn?: string; lid?: string }> => {
	const normalized = toJid(jid)
	if (!normalized) return {}
	if (isLidUser(normalized)) {
		const pn = await lookup.getPNForLID(normalized).catch(() => null)
		return { lid: normalized, ...(pn ? { pn: jidNormalizedUser(pn) } : {}) }
	}

	if (isPnUser(normalized)) {
		const lid = await lookup.getLIDForPN(normalized).catch(() => null)
		return { pn: normalized, ...(lid ? { lid: jidNormalizedUser(lid) } : {}) }
	}

	return {}
}

/**
 * true when both values are the same WhatsApp user, also when one is a phone
 * number (or bare digits) and the other one is that user's LID.
 */
export const isSameUser = async (a: string | undefined | null, b: string | undefined | null, lookup: JidLookup) => {
	if (!a || !b) return false
	const ja = toJid(a)
	const jb = toJid(b)
	if (!ja || !jb) return false
	const sameServerKind = isLidUser(ja) === isLidUser(jb)
	if (sameServerKind) return userOf(ja) === userOf(jb)

	const [ra, rb] = await Promise.all([resolveUserJids(ja, lookup), resolveUserJids(jb, lookup)])
	return (!!ra.pn && userOf(ra.pn) === userOf(rb.pn)) || (!!ra.lid && userOf(ra.lid) === userOf(rb.lid))
}

const VIEW_ONCE_MEDIA = ['imageMessage', 'videoMessage', 'audioMessage'] as const
export type ViewOnceMediaType = 'image' | 'video' | 'audio'
export type ViewOnceContent = {
	type: ViewOnceMediaType
	/** bare media message, ready for downloadMediaMessage */
	message: proto.IMessage
	mimetype?: string
	caption?: string
}

const unwrapOnce = (m: proto.IMessage | null | undefined): proto.IMessage | undefined => {
	let current = m || undefined
	for (let i = 0; i < 6 && current; i++) {
		const inner =
			current.ephemeralMessage?.message ||
			current.viewOnceMessage?.message ||
			current.viewOnceMessageV2?.message ||
			current.viewOnceMessageV2Extension?.message ||
			current.documentWithCaptionMessage?.message
		if (!inner) break
		current = inner
	}

	return current
}

/**
 * Find the view-once media in a message, or in the message it quotes.
 * Returns undefined when there is none.
 */
export const extractViewOnceContent = (message: proto.IMessage | null | undefined): ViewOnceContent | undefined => {
	const pick = (m: proto.IMessage | null | undefined, requireFlag: boolean): ViewOnceContent | undefined => {
		const wrapped =
			!!m?.viewOnceMessage || !!m?.viewOnceMessageV2 || !!m?.viewOnceMessageV2Extension || !!m?.ephemeralMessage
		const inner = unwrapOnce(m)
		if (!inner) return undefined
		for (const field of VIEW_ONCE_MEDIA) {
			const media = inner[field]
			if (!media) continue
			const isViewOnce = !!media.viewOnce || (wrapped && !m?.ephemeralMessage) || (wrapped && !!media.viewOnce)
			if (requireFlag && !isViewOnce) continue
			return {
				type: field.replace('Message', '') as ViewOnceMediaType,
				message: { [field]: media },
				mimetype: media.mimetype || undefined,
				caption: ('caption' in media && media.caption) || undefined
			}
		}

		return undefined
	}

	const direct = pick(message, true)
	if (direct) return direct

	const inner = unwrapOnce(message)
	if (!inner) return undefined
	for (const value of Object.values(inner)) {
		const quoted = (value as { contextInfo?: proto.IContextInfo } | null)?.contextInfo?.quotedMessage
		if (quoted) {
			// a quoted view-once often loses its wrapper, so the flag is not required here
			const found = pick(quoted, true) || pick(quoted, false)
			if (found) return found
		}
	}

	return undefined
}

/** throws a clear error when a view-once can no longer be downloaded */
export const assertViewOnceDownloadable = (content: ViewOnceContent) => {
	const media = Object.values(content.message)[0] as { mediaKey?: Uint8Array | null; url?: string; directPath?: string }
	if (!media?.mediaKey?.length) {
		throw new Boom('view-once media key is missing (already opened, or WhatsApp sent only a placeholder)', {
			statusCode: 410
		})
	}

	if (!media.url && !media.directPath) {
		throw new Boom('view-once media has no download location', { statusCode: 410 })
	}
}

export const compareVersions = (a: readonly number[], b: readonly number[]) => {
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const diff = (a[i] ?? 0) - (b[i] ?? 0)
		if (diff) return diff
	}

	return 0
}

const isVersion = (v: unknown): v is WAVersion =>
	Array.isArray(v) && v.length === 3 && v.every(n => Number.isInteger(n) && n >= 0)

/** newest of the given versions; invalid entries are ignored */
export const pickNewestVersion = (...versions: unknown[]): WAVersion | undefined => {
	let best: WAVersion | undefined
	for (const v of versions) {
		if (isVersion(v) && (!best || compareVersions(v, best) > 0)) best = v
	}

	return best
}

export type VersionStoreOptions = {
	/** JSON file that remembers the newest version seen */
	file: string
	/** version shipped with the library, used as the floor */
	bundled?: WAVersion
	/** resolves the latest version; only trusted when `isLatest` is true */
	fetchLatest?: () => Promise<{ version: WAVersion; isLatest?: boolean }>
}

/**
 * Remembers the newest WhatsApp Web version on disk, so a restart or a failed
 * version fetch never falls back to an older revision (which makes WhatsApp
 * close the connection with 408 again and again).
 */
export const createVersionStore = ({ file, bundled, fetchLatest }: VersionStoreOptions) => {
	const read = async (): Promise<WAVersion | undefined> => {
		try {
			const parsed = JSON.parse(await fs.readFile(file, 'utf8'))
			return isVersion(parsed?.version) ? parsed.version : undefined
		} catch {
			return undefined
		}
	}

	const write = async (version: WAVersion) => {
		await fs.mkdir(dirname(file), { recursive: true })
		const tmp = `${file}.tmp`
		await fs.writeFile(tmp, JSON.stringify({ version, savedAt: new Date().toISOString() }))
		await fs.rename(tmp, file)
	}

	/** newest known version without touching the network */
	const get = async () => pickNewestVersion(await read(), bundled)

	/** fetch the latest version, keep whichever is newest, and save it */
	const resolve = async (): Promise<WAVersion | undefined> => {
		const stored = await read()
		let fetched: WAVersion | undefined
		if (fetchLatest) {
			try {
				const result = await fetchLatest()
				if (result?.isLatest !== false) fetched = result.version
			} catch {
				// keep the last good version
			}
		}

		const best = pickNewestVersion(stored, bundled, fetched)
		if (best && (!stored || compareVersions(best, stored) > 0)) {
			await write(best).catch(() => {})
		}

		return best
	}

	return { get, resolve }
}

export type SendQueueOptions = {
	/** minimum gap between any two sends (default 1000ms) */
	minDelayMs?: number
	/** minimum gap between two sends to the same chat (default 1500ms) */
	perChatDelayMs?: number
	/** random extra wait added to every gap (default 500ms) */
	jitterMs?: number
	/** hard cap of sends per rolling minute (default 20) */
	maxPerMinute?: number
	now?: () => number
	sleep?: (ms: number) => Promise<void>
	random?: () => number
}

type Sender = {
	sendMessage: (jid: string, content: AnyMessageContent, options?: MiscMessageGenerationOptions) => Promise<any>
}

/**
 * Sends messages one after another with a gap, so a broadcast style command
 * does not fire dozens of messages in the same second.
 */
export const createSendQueue = (sock: Sender, options: SendQueueOptions = {}) => {
	const minDelayMs = options.minDelayMs ?? 1000
	const perChatDelayMs = options.perChatDelayMs ?? 1500
	const jitterMs = options.jitterMs ?? 500
	const maxPerMinute = options.maxPerMinute ?? 20
	const now = options.now ?? Date.now
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
	const random = options.random ?? Math.random

	const lastPerChat = new Map<string, number>()
	let lastSend = -Infinity
	let recent: number[] = []
	let pending = 0
	let generation = 0
	let chain: Promise<unknown> = Promise.resolve()

	const waitTurn = async (jid: string) => {
		for (;;) {
			const t = now()
			recent = recent.filter(at => t - at < 60_000)
			const waits = [lastSend + minDelayMs - t, (lastPerChat.get(jid) ?? -Infinity) + perChatDelayMs - t]
			if (recent.length >= maxPerMinute) waits.push(recent[0]! + 60_000 - t)
			const wait = Math.max(0, ...waits)
			if (wait <= 0) return
			await sleep(wait)
		}
	}

	const send = <T = WAMessage | undefined>(
		jid: string,
		content: AnyMessageContent,
		sendOptions?: MiscMessageGenerationOptions
	): Promise<T> => {
		const mine = generation
		pending++
		const run = async () => {
			try {
				if (mine !== generation) throw new Boom('send queue was cleared', { statusCode: 499 })
				await waitTurn(jid)
				if (jitterMs > 0) await sleep(Math.floor(random() * jitterMs))
				if (mine !== generation) throw new Boom('send queue was cleared', { statusCode: 499 })
				const at = now()
				lastSend = at
				lastPerChat.set(jid, at)
				recent.push(at)
				return (await sock.sendMessage(jid, content, sendOptions)) as T
			} finally {
				pending--
			}
		}

		const result = chain.then(run, run)
		chain = result.catch(() => {})
		return result
	}

	return {
		send,
		/** number of messages waiting or being sent */
		get size() {
			return pending
		},
		/** drop everything that has not been sent yet */
		clear: () => {
			generation++
		},
		/** resolves when the queue is empty */
		idle: () => chain.then(() => {})
	}
}
