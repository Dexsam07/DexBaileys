import { jest } from '@jest/globals'
import { EventEmitter } from 'events'
import { promises as fs, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DEFAULT_CACHE_TTLS } from '../../Defaults'
import { makeDexHelpers } from '../../Socket/dex'
import {
	clearWaWebVersionCache,
	exportSessionId,
	extractImageThumb,
	generateThumbnail,
	migrateSession,
	mongoKeyValueStore,
	prepareWAMessageMedia,
	quietSignalLogs,
	redisKeyValueStore,
	resolveWaWebVersion,
	useKeyValueAuthState,
	useSingleFileAuthState,
	withTimeLimit
} from '../../Utils'

const mapStore = () => {
	const map = new Map<string, string>()
	return {
		map,
		get: async (k: string) => map.get(k),
		set: async (k: string, v: string) => void map.set(k, v),
		delete: async (k: string) => void map.delete(k)
	}
}

const fakeMongo = () => {
	const docs = new Map<string, any>()
	return {
		docs,
		findOne: async (f: any) => docs.get(f._id) ?? null,
		replaceOne: async (f: any, doc: any, o: any) => {
			if (!o?.upsert && !docs.has(f._id)) return
			docs.set(f._id, doc)
		},
		deleteOne: async (f: any) => void docs.delete(f._id),
		deleteMany: async (f: any) => {
			const re = new RegExp(f._id.$regex)
			for (const k of [...docs.keys()]) if (re.test(k)) docs.delete(k)
		}
	}
}

const fakeRedis = () => {
	const map = new Map<string, string>()
	return {
		map,
		get: async (k: string) => map.get(k) ?? null,
		set: async (k: string, v: string) => void map.set(k, v),
		del: async (k: string) => void map.delete(k),
		keys: async (pattern: string) => [...map.keys()].filter(k => k.startsWith(pattern.slice(0, -1)))
	}
}

describe('database session', () => {
	it('saves the login and reads it back after a restart', async () => {
		const store = mapStore()
		const first = await useKeyValueAuthState(store)
		first.state.creds.me = { id: '911:1@s.whatsapp.net', name: 'Dex' }
		await first.saveCreds()
		await first.state.keys.set({
			'pre-key': { '5': { public: Buffer.from([1, 2, 3]), private: Buffer.from([4, 5, 6]) } },
			'app-state-sync-key': { AAAA: { keyData: Buffer.from('k'), timestamp: 5 } as any }
		})

		const second = await useKeyValueAuthState(store)
		expect(second.state.creds.me?.id).toBe('911:1@s.whatsapp.net')
		expect(Buffer.compare(second.state.creds.noiseKey.private, first.state.creds.noiseKey.private)).toBe(0)
		const keys = await second.state.keys.get('pre-key', ['5', '6'])
		expect(Buffer.isBuffer(keys['5']!.public)).toBe(true)
		expect([...keys['5']!.private]).toEqual([4, 5, 6])
		expect(keys['6']).toBeUndefined()
		const sync = await second.state.keys.get('app-state-sync-key', ['AAAA'])
		expect(typeof (sync.AAAA as any).toJSON).toBe('function')

		await second.state.keys.set({ 'pre-key': { '5': null } })
		expect((await second.state.keys.get('pre-key', ['5']))['5']).toBeUndefined()
	})

	it('keeps two bots apart with a prefix and restores from a session string', async () => {
		const store = mapStore()
		const a = await useKeyValueAuthState(store, { prefix: 'a:' })
		a.state.creds.me = { id: '1:1@s.whatsapp.net' }
		await a.saveCreds()
		const b = await useKeyValueAuthState(store, { prefix: 'b:' })
		expect(b.state.creds.me).toBeUndefined()

		const sessionId = exportSessionId({ creds: a.state.creds, keys: { 'pre-key': { '9': { x: 1 } } } } as any, {
			full: true
		})
		const fresh = mapStore()
		const restored = await useKeyValueAuthState(fresh, { sessionId })
		expect(restored.state.creds.me?.id).toBe('1:1@s.whatsapp.net')
		expect(fresh.map.has('dex:creds')).toBe(true)
		expect((await restored.state.keys.get('pre-key', ['9']))['9']).toEqual({ x: 1 })
		// an existing login wins over the session string
		const again = await useKeyValueAuthState(fresh, { sessionId: 'DEX~broken' })
		expect(again.state.creds.me?.id).toBe('1:1@s.whatsapp.net')
	})

	it('works with a real Keyv instance', async () => {
		const { Keyv } = await import('keyv')
		const keyv: any = new Keyv()
		const first = await useKeyValueAuthState(keyv)
		first.state.creds.me = { id: '77:1@s.whatsapp.net' }
		await first.saveCreds()
		await first.state.keys.set({ session: { 'a.0': Buffer.from('sess') as any } })
		const second = await useKeyValueAuthState(keyv)
		expect(second.state.creds.me?.id).toBe('77:1@s.whatsapp.net')
		expect(((await second.state.keys.get('session', ['a.0']))['a.0'] as any).toString()).toBe('sess')
	})

	it('works through the MongoDB and Redis adapters and can clear', async () => {
		const mongo = fakeMongo()
		const m = await useKeyValueAuthState(mongoKeyValueStore(mongo), { prefix: 'bot1:' })
		m.state.creds.me = { id: '2:1@s.whatsapp.net' }
		await m.saveCreds()
		await m.state.keys.set({ 'pre-key': { '1': { a: 1 } as any } })
		mongo.docs.set('other', { _id: 'other', value: 'keep' })
		expect(mongo.docs.get('bot1:creds').value).toEqual(expect.any(String))
		expect((await useKeyValueAuthState(mongoKeyValueStore(mongo), { prefix: 'bot1:' })).state.creds.me?.id).toBe(
			'2:1@s.whatsapp.net'
		)
		await m.clear()
		expect([...mongo.docs.keys()]).toEqual(['other'])

		const redis = fakeRedis()
		const r = await useKeyValueAuthState(redisKeyValueStore(redis))
		r.state.creds.me = { id: '3:1@s.whatsapp.net' }
		await r.saveCreds()
		await r.state.keys.set({ 'pre-key': { '1': { a: 1 } as any } })
		redis.map.set('unrelated', 'x')
		expect((await useKeyValueAuthState(redisKeyValueStore(redis))).state.creds.me?.id).toBe('3:1@s.whatsapp.net')
		await r.clear()
		expect([...redis.map.keys()]).toEqual(['unrelated'])
	})

	it('gives clear errors', async () => {
		await expect(useKeyValueAuthState({} as any)).rejects.toMatchObject({ output: { statusCode: 400 } })
		const broken = mapStore()
		broken.map.set('dex:creds', '{not json')
		await expect(useKeyValueAuthState(broken)).rejects.toMatchObject({ output: { statusCode: 500 } })
		const noLogin = mapStore()
		noLogin.map.set('dex:creds', '{"hello":1}')
		await expect(useKeyValueAuthState(noLogin)).rejects.toMatchObject({ output: { statusCode: 500 } })
		const plain = await useKeyValueAuthState(mapStore())
		await expect(plain.clear()).rejects.toMatchObject({ output: { statusCode: 501 } })
		expect(() => mongoKeyValueStore({} as any)).toThrow()
		expect(() => redisKeyValueStore({} as any)).toThrow()
	})

	it('moves a session file into a database', async () => {
		const dir = await fs.mkdtemp(join(tmpdir(), 'dex-store-'))
		const file = join(dir, 'session.json')
		const src = await useSingleFileAuthState(file)
		src.state.creds.me = { id: '5:1@s.whatsapp.net' }
		await src.state.keys.set({ 'pre-key': { '1': { a: 1 } as any, '2': { b: 2 } as any } })
		await src.saveCreds()
		await src.flush()

		const store = mapStore()
		const result = await migrateSession({ file }, { store, prefix: 'm:' })
		expect(result.keys).toBe(2)
		const target = await useKeyValueAuthState(store, { prefix: 'm:' })
		expect(target.state.creds.me?.id).toBe('5:1@s.whatsapp.net')
		expect((await target.state.keys.get('pre-key', ['2']))['2']).toEqual({ b: 2 })
		await expect(migrateSession({ file }, { store, prefix: 'm:' })).rejects.toMatchObject({
			output: { statusCode: 409 }
		})
		await fs.rm(dir, { recursive: true, force: true })
	})
})

describe('speed pack', () => {
	beforeEach(() => clearWaWebVersionCache())

	it('uses longer cache lives', () => {
		expect(DEFAULT_CACHE_TTLS.USER_DEVICES).toBe(30 * 60)
		expect(DEFAULT_CACHE_TTLS.SIGNAL_STORE).toBe(15 * 60)
	})

	it('asks for the live version once per hour and shares the answer', async () => {
		let t = 1000
		const fetchLatest = jest.fn(async () => ({ version: [2, 3000, 2000], isLatest: true }))
		const opts = { fetchLatest, now: () => t, bundled: [2, 3000, 1000] as any }
		const [a, b] = await Promise.all([resolveWaWebVersion(opts), resolveWaWebVersion(opts)])
		expect(a).toEqual([2, 3000, 2000])
		expect(b).toEqual([2, 3000, 2000])
		t += 59 * 60 * 1000
		await resolveWaWebVersion(opts)
		expect(fetchLatest).toHaveBeenCalledTimes(1)
		t += 2 * 60 * 1000
		await resolveWaWebVersion(opts)
		expect(fetchLatest).toHaveBeenCalledTimes(2)
		clearWaWebVersionCache()
		await resolveWaWebVersion(opts)
		expect(fetchLatest).toHaveBeenCalledTimes(3)
	})

	it('keeps the bundled version when the answer is older, unusable, failing or slow', async () => {
		const bundled = [2, 3000, 5000] as any
		expect(
			await resolveWaWebVersion({ bundled, fetchLatest: async () => ({ version: [2, 3000, 4000], isLatest: true }) })
		).toBeUndefined()
		clearWaWebVersionCache()

		const bad = jest.fn(async () => ({ version: [2, 3000, 9000], isLatest: false }))
		expect(await resolveWaWebVersion({ bundled, fetchLatest: bad })).toBeUndefined()
		expect(await resolveWaWebVersion({ bundled, fetchLatest: bad })).toBeUndefined()
		// a failure is not remembered, the next connect asks again
		expect(bad).toHaveBeenCalledTimes(2)

		expect(
			await resolveWaWebVersion({
				bundled,
				fetchLatest: async () => {
					throw new Error('offline')
				}
			})
		).toBeUndefined()

		const started = Date.now()
		expect(
			await resolveWaWebVersion({ bundled, timeoutMs: 50, fetchLatest: () => new Promise(() => {}) as any })
		).toBeUndefined()
		expect(Date.now() - started).toBeLessThan(1000)
	})

	it('hides only the routine Signal session messages', () => {
		const info = jest.spyOn(console, 'info').mockImplementation(() => {})
		const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
		const error = jest.spyOn(console, 'error').mockImplementation(() => {})
		const restore = quietSignalLogs()
		expect(quietSignalLogs()).toBe(restore)
		console.info('Closing session:', { big: 'object' })
		console.info('Opening session:', {})
		console.info('bot started')
		console.warn('Session already closed', {})
		console.warn('careful')
		console.error('Failed to decrypt message with any known session...')
		expect(info.mock.calls).toEqual([['bot started']])
		expect(warn.mock.calls).toEqual([['careful']])
		expect(error).toHaveBeenCalledTimes(1)
		restore()
		console.info('Closing session:', 1)
		expect(info).toHaveBeenCalledTimes(2)
		info.mockRestore()
		warn.mockRestore()
		error.mockRestore()
	})

	it('gives up on slow work after the limit', async () => {
		expect(await withTimeLimit(new Promise(r => setTimeout(() => r('late'), 300)), 30)).toBeUndefined()
		expect(await withTimeLimit(Promise.resolve('fast'), 30)).toBe('fast')
		expect(await withTimeLimit(Promise.resolve('no limit'), 0)).toBe('no limit')
	})
})

describe('HD send', () => {
	const cat = join(process.cwd(), 'Media', 'cat.jpeg')
	const upload = async () => ({ mediaUrl: 'https://mmg.whatsapp.net/x', directPath: '/x' })

	it('builds a larger preview and leaves the photo itself untouched', async () => {
		const original = readFileSync(cat)
		const normal = await prepareWAMessageMedia({ image: original }, { upload } as any)
		const hd = await prepareWAMessageMedia({ image: original, hd: true } as any, { upload } as any)
		const small = Buffer.from(normal.imageMessage!.jpegThumbnail as any)
		const big = Buffer.from(hd.imageMessage!.jpegThumbnail as any)
		const sharp = (await import('sharp')).default
		expect((await sharp(small).metadata()).width).toBe(32)
		expect((await sharp(big).metadata()).width).toBe(200)
		expect(big.length).toBeGreaterThan(small.length)
		expect(big.length).toBeLessThan(40 * 1024)
		// same file either way: nothing is re-encoded
		expect(Number(hd.imageMessage!.fileLength)).toBe(original.length)
		expect(Buffer.from(hd.imageMessage!.fileSha256!).equals(Buffer.from(normal.imageMessage!.fileSha256!))).toBe(true)
		expect((hd.imageMessage as any).hd).toBeUndefined()
		expect(hd.imageMessage!.width).toBeGreaterThan(0)
	})

	it('builds a larger video preview and keeps a preview the caller supplied', async () => {
		const video = join(process.cwd(), 'Media', 'ma_gif.mp4')
		const normal = await generateThumbnail(video, 'video', {})
		const hd = await generateThumbnail(video, 'video', { hd: true })
		const sharp = (await import('sharp')).default
		expect((await sharp(Buffer.from(normal.thumbnail!, 'base64')).metadata()).width).toBe(32)
		expect((await sharp(Buffer.from(hd.thumbnail!, 'base64')).metadata()).width).toBe(200)

		const own = (await extractImageThumb(readFileSync(cat), 48)).buffer.toString('base64')
		const kept = await prepareWAMessageMedia({ image: readFileSync(cat), hd: true, jpegThumbnail: own } as any, {
			upload
		} as any)
		expect(Buffer.from(kept.imageMessage!.jpegThumbnail as any).toString('base64')).toBe(own)
	})

	it('sock.sendHD marks photos and videos and refuses anything else', async () => {
		const sent: any[] = []
		const sock: any = {
			ev: new EventEmitter(),
			user: { id: '911:1@s.whatsapp.net' },
			sendMessage: jest.fn(async (jid: string, c: any) => {
				sent.push(c)
				return { key: { remoteJid: jid, id: 'M1', fromMe: true } }
			}),
			signalRepository: { lidMapping: {} }
		}
		const dex = makeDexHelpers(sock, undefined as any)
		await dex.sendHD('1@s.whatsapp.net', { image: Buffer.from('x'), caption: 'hi' })
		expect(sent[0]).toMatchObject({ hd: true, caption: 'hi' })
		expect(() => dex.sendHD('1@s.whatsapp.net', { audio: Buffer.from('x') } as any)).toThrow()
	})
})
