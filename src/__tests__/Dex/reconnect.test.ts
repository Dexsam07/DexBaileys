import { jest } from '@jest/globals'
import { EventEmitter } from 'events'
import { DisconnectReason } from '../../Types'
import {
	computeBackoff,
	createReconnectManager,
	handleCompanionRegRefresh,
	normalizePairingPhoneNumber,
	shouldReconnectByDefault
} from '../../Utils'

const makeSock = () => {
	const ev = new EventEmitter()
	return {
		ev: { on: (e: 'connection.update', l: (u: any) => void) => void ev.on(e, l) },
		emit: (u: any) => ev.emit('connection.update', u),
		close: (statusCode?: number) =>
			ev.emit('connection.update', {
				connection: 'close',
				lastDisconnect: { error: statusCode === undefined ? undefined : { output: { statusCode } } }
			})
	}
}

describe('normalizePairingPhoneNumber', () => {
	it('reduces every notation to the same digits', () => {
		expect(normalizePairingPhoneNumber('+91 73842-87404')).toBe('917384287404')
		expect(normalizePairingPhoneNumber('917384287404')).toBe('917384287404')
		expect(normalizePairingPhoneNumber('00917384287404')).toBe('917384287404')
		expect(normalizePairingPhoneNumber(917384287404)).toBe('917384287404')
		expect(normalizePairingPhoneNumber('07384287404', { defaultCountryCode: '+91' })).toBe('917384287404')
	})

	it('rejects unusable input', () => {
		expect(normalizePairingPhoneNumber('')).toBeUndefined()
		expect(normalizePairingPhoneNumber('abc')).toBeUndefined()
		expect(normalizePairingPhoneNumber('12345')).toBeUndefined()
		expect(normalizePairingPhoneNumber('1234567890123456')).toBeUndefined()
		expect(normalizePairingPhoneNumber(undefined as any)).toBeUndefined()
	})
})

describe('handleCompanionRegRefresh', () => {
	const node = (child?: string) => ({
		tag: 'notification',
		attrs: { id: '1', type: 'companion_reg_refresh' },
		content: child ? [{ tag: child, attrs: {} }] : []
	})

	it('rotates the secret and re-renders the QR for an unpaired session', () => {
		const creds: any = { advSecretKey: 'old' }
		const emitCredsUpdate = jest.fn()
		const refreshQR = jest.fn()
		expect(handleCompanionRegRefresh(node('companion_reg_refresh'), { creds, emitCredsUpdate, refreshQR })).toBe('rotated')
		expect(creds.advSecretKey).not.toBe('old')
		expect(Buffer.from(creds.advSecretKey, 'base64')).toHaveLength(32)
		expect(emitCredsUpdate).toHaveBeenCalledWith({ advSecretKey: creds.advSecretKey })
		expect(refreshQR).toHaveBeenCalledTimes(1)
		expect(handleCompanionRegRefresh(node('pair-device-rotate-qr'), { creds })).toBe('rotated')
	})

	it('leaves registered sessions and malformed stanzas alone', () => {
		const registered: any = { advSecretKey: 'keep', me: { id: '1@s.whatsapp.net' } }
		const refreshQR = jest.fn()
		expect(handleCompanionRegRefresh(node('companion_reg_refresh'), { creds: registered, refreshQR })).toBe(
			'ignored_registered'
		)
		expect(registered.advSecretKey).toBe('keep')

		const fresh: any = { advSecretKey: 'keep' }
		expect(handleCompanionRegRefresh(node(), { creds: fresh, refreshQR })).toBe('ignored_malformed')
		expect(fresh.advSecretKey).toBe('keep')
		expect(refreshQR).not.toHaveBeenCalled()
	})
})

describe('reconnect policy', () => {
	it('backs off exponentially up to the cap', () => {
		const at = (attempt: number) => computeBackoff({ attempt, jitter: 0 })
		expect([1, 2, 3, 4, 5, 6, 10].map(at)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000])
		const jittered = computeBackoff({ attempt: 3, jitter: 0.3, random: () => 0 })
		expect(jittered).toBe(2800)
		expect(computeBackoff({ attempt: 3, jitter: 0.3, random: () => 1 })).toBe(4000)
	})

	it('refuses final disconnects by default', () => {
		expect(shouldReconnectByDefault(DisconnectReason.loggedOut)).toBe(false)
		expect(shouldReconnectByDefault(DisconnectReason.forbidden)).toBe(false)
		expect(shouldReconnectByDefault(DisconnectReason.multideviceMismatch)).toBe(false)
		expect(shouldReconnectByDefault(DisconnectReason.connectionLost)).toBe(true)
		expect(shouldReconnectByDefault(DisconnectReason.restartRequired)).toBe(true)
		expect(shouldReconnectByDefault(undefined)).toBe(true)
	})
})

describe('createReconnectManager', () => {
	beforeEach(() => jest.useFakeTimers())
	afterEach(() => jest.useRealTimers())
	const flush = async () => {
		for (let i = 0; i < 10; i++) await Promise.resolve()
	}

	it('reconnects with backoff and resets after an open', async () => {
		const socks: ReturnType<typeof makeSock>[] = []
		const contexts: any[] = []
		const manager = createReconnectManager({
			connect: ctx => {
				contexts.push(ctx)
				const s = makeSock()
				socks.push(s)
				return s
			},
			jitter: 0
		})
		await manager.start()
		expect(socks).toHaveLength(1)

		socks[0]!.close(DisconnectReason.connectionClosed)
		await flush()
		jest.advanceTimersByTime(999)
		await flush()
		expect(socks).toHaveLength(1)
		jest.advanceTimersByTime(1)
		await flush()
		expect(socks).toHaveLength(2)
		expect(contexts[1]).toMatchObject({ attempt: 1, statusCode: DisconnectReason.connectionClosed })

		// second failure in a row waits 2s
		socks[1]!.close(DisconnectReason.connectionClosed)
		await flush()
		jest.advanceTimersByTime(1999)
		await flush()
		expect(socks).toHaveLength(2)
		jest.advanceTimersByTime(1)
		await flush()
		expect(socks).toHaveLength(3)

		// a successful open resets the counter
		socks[2]!.emit({ connection: 'open' })
		expect(manager.attempt).toBe(0)
		socks[2]!.close(DisconnectReason.connectionClosed)
		await flush()
		jest.advanceTimersByTime(1000)
		await flush()
		expect(socks).toHaveLength(4)
	})

	it('never reconnects a logged-out session', async () => {
		const socks: ReturnType<typeof makeSock>[] = []
		const onGiveUp = jest.fn()
		const manager = createReconnectManager({
			connect: () => {
				const s = makeSock()
				socks.push(s)
				return s
			},
			onGiveUp
		})
		await manager.start()
		socks[0]!.close(DisconnectReason.loggedOut)
		await flush()
		jest.advanceTimersByTime(120_000)
		await flush()
		expect(socks).toHaveLength(1)
		expect(onGiveUp).toHaveBeenCalledWith(DisconnectReason.loggedOut, expect.anything())
	})

	it('restarts quickly after 515 and ignores duplicate close events', async () => {
		const socks: ReturnType<typeof makeSock>[] = []
		const manager = createReconnectManager({
			connect: () => {
				const s = makeSock()
				socks.push(s)
				return s
			}
		})
		await manager.start()
		socks[0]!.close(DisconnectReason.restartRequired)
		socks[0]!.close(DisconnectReason.restartRequired)
		await flush()
		jest.advanceTimersByTime(500)
		await flush()
		expect(socks).toHaveLength(2)
		// a late close from the replaced socket must not open a third one
		socks[0]!.close(DisconnectReason.connectionClosed)
		await flush()
		jest.advanceTimersByTime(60_000)
		await flush()
		expect(socks).toHaveLength(2)
	})

	it('refreshes the version after a 408 and keeps the last good one when the fetch fails', async () => {
		const socks: ReturnType<typeof makeSock>[] = []
		const contexts: any[] = []
		const versionProvider = jest
			.fn<() => Promise<[number, number, number] | undefined>>()
			.mockResolvedValueOnce([2, 3000, 5])
			.mockRejectedValueOnce(new Error('offline'))
		const manager = createReconnectManager({
			connect: ctx => {
				contexts.push(ctx)
				const s = makeSock()
				socks.push(s)
				return s
			},
			versionProvider,
			jitter: 0
		})
		await manager.start()
		socks[0]!.close(DisconnectReason.timedOut)
		await flush()
		jest.advanceTimersByTime(1000)
		await flush()
		expect(contexts[1].version).toEqual([2, 3000, 5])

		socks[1]!.close(DisconnectReason.timedOut)
		await flush()
		jest.advanceTimersByTime(2000)
		await flush()
		expect(socks).toHaveLength(3)
		expect(contexts[2].version).toEqual([2, 3000, 5])
		expect(versionProvider).toHaveBeenCalledTimes(2)
	})

	it('stops at maxRetries and when stop() is called', async () => {
		const socks: ReturnType<typeof makeSock>[] = []
		const onGiveUp = jest.fn()
		const manager = createReconnectManager({
			connect: () => {
				const s = makeSock()
				socks.push(s)
				return s
			},
			maxRetries: 1,
			jitter: 0,
			onGiveUp
		})
		await manager.start()
		socks[0]!.close(DisconnectReason.connectionClosed)
		await flush()
		jest.advanceTimersByTime(1000)
		await flush()
		expect(socks).toHaveLength(2)
		socks[1]!.close(DisconnectReason.connectionClosed)
		await flush()
		jest.advanceTimersByTime(60_000)
		await flush()
		expect(socks).toHaveLength(2)
		expect(onGiveUp).toHaveBeenCalledTimes(1)

		const other: ReturnType<typeof makeSock>[] = []
		const second = createReconnectManager({
			connect: () => {
				const s = makeSock()
				other.push(s)
				return s
			}
		})
		await second.start()
		second.stop()
		other[0]!.close(DisconnectReason.connectionClosed)
		await flush()
		jest.advanceTimersByTime(60_000)
		await flush()
		expect(other).toHaveLength(1)
	})
})
