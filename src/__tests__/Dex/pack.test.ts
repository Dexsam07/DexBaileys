import { jest } from '@jest/globals'
import { createHash, createDecipheriv } from 'crypto'
import { EventEmitter } from 'events'
import { promises as fs, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { inflateRawSync } from 'zlib'
import { proto } from '../../../WAProto/index.js'
import { makeDexHelpers } from '../../Socket/dex'
import {
	buildGroupStatusMessage,
	crc32,
	createStoredZip,
	getMediaKeys,
	normalizeMessageContent,
	planStickerPack,
	sqliteKeyValueStore,
	useMultiFileAuthState,
	useSqliteAuthState
} from '../../Utils'

void inflateRawSync

/** minimal reader for stored zips: returns name -> data */
const readZip = (zip: Buffer) => {
	const out = new Map<string, Buffer>()
	const end = zip.length - 22
	expect(zip.readUInt32LE(end)).toBe(0x06054b50)
	const count = zip.readUInt16LE(end + 10)
	let p = zip.readUInt32LE(end + 16)
	for (let i = 0; i < count; i++) {
		expect(zip.readUInt32LE(p)).toBe(0x02014b50)
		const crc = zip.readUInt32LE(p + 16)
		const size = zip.readUInt32LE(p + 24)
		const nameLen = zip.readUInt16LE(p + 28)
		const local = zip.readUInt32LE(p + 42)
		const name = zip.subarray(p + 46, p + 46 + nameLen).toString()
		expect(zip.readUInt32LE(local)).toBe(0x04034b50)
		const dataStart = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
		const data = zip.subarray(dataStart, dataStart + size)
		expect(crc32(data)).toBe(crc)
		out.set(name, Buffer.from(data))
		p += 46 + nameLen
	}

	return out
}

const media = (name: string) => readFileSync(join(process.cwd(), 'Media', name))

const fakeSock = () => {
	const uploads: { path: string; type: string; enc: Buffer }[] = []
	const relayed: any[] = []
	const sock: any = {
		ev: new EventEmitter(),
		user: { id: '911:7@s.whatsapp.net', lid: '555:7@lid' },
		signalRepository: { lidMapping: {} },
		sendMessage: jest.fn(),
		relayMessage: jest.fn(async (jid: string, message: any, opts: any) => {
			relayed.push({ jid, message, opts })
		}),
		waUploadToServer: jest.fn(async (path: string, o: any) => {
			uploads.push({ path, type: o.mediaType, enc: readFileSync(path) })
			return { mediaUrl: 'https://mmg.whatsapp.net/u', directPath: `/v/${o.mediaType}/${uploads.length}` }
		})
	}
	return { sock, uploads, relayed, dex: makeDexHelpers(sock, undefined as any) }
}

const decryptMedia = async (enc: Buffer, mediaKey: Uint8Array, type: any) => {
	const { cipherKey, iv } = await getMediaKeys(mediaKey, type)
	const d = createDecipheriv('aes-256-cbc', cipherKey, iv)
	return Buffer.concat([d.update(enc.subarray(0, enc.length - 10)), d.final()])
}

describe('zip', () => {
	it('matches the known CRC-32 value and packs files that read back', () => {
		expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926)
		const zip = createStoredZip([
			{ name: 'a.webp', data: Buffer.from('hello') },
			{ name: 'ट्रे.png', data: Buffer.alloc(3000, 7) }
		])
		const files = readZip(zip)
		expect([...files.keys()]).toEqual(['a.webp', 'ट्रे.png'])
		expect(files.get('a.webp')!.toString()).toBe('hello')
		expect(files.get('ट्रे.png')!.length).toBe(3000)
		expect(() => createStoredZip([])).toThrow()
		expect(() => createStoredZip([{ name: 'x', data: Buffer.alloc(1) }, { name: 'x', data: Buffer.alloc(1) }])).toThrow()
	})
})

describe('sticker pack', () => {
	it('checks the pack before any upload', () => {
		const one = [{ data: Buffer.from('x') }]
		expect(() => planStickerPack({ name: '', publisher: 'p' }, one)).toThrow()
		expect(() => planStickerPack({ name: 'n', publisher: 'p' }, [])).toThrow()
		expect(() => planStickerPack({ name: 'n', publisher: 'p' }, new Array(61).fill(one[0]))).toThrow()
		expect(() => planStickerPack({ name: 'n', publisher: 'p' }, [{ data: Buffer.alloc(0) }])).toThrow()
		const plan = planStickerPack({ name: 'n', publisher: 'p' }, [
			{ data: Buffer.from('a'), fileName: 'same.webp' },
			{ data: Buffer.from('b'), fileName: 'same.webp' }
		])
		expect(new Set(plan.files.map(f => f.fileName)).size).toBe(2)
		expect(plan.stickerPackId).toMatch(/^[0-9a-f-]{36}$/)
	})

	it('zips, encrypts, uploads and sends one pack message', async () => {
		const { dex, uploads, relayed } = fakeSock()
		const webp = media('octopus.webp')
		const result = await dex.sendStickerPack('123@s.whatsapp.net', {
			name: 'DEX Pack',
			publisher: 'Shyam',
			description: 'test',
			stickers: [webp, { data: media('cat.jpeg'), emojis: ['🐱'] }, { data: media('ma_gif.mp4') }]
		})
		expect(result.stickers).toBe(3)
		expect(uploads.map(u => u.type)).toEqual(['sticker-pack', 'thumbnail-sticker-pack'])
		// temp files are removed
		for (const u of uploads) await expect(fs.stat(u.path)).rejects.toBeTruthy()

		expect(relayed).toHaveLength(1)
		expect(relayed[0].opts.messageId).toBe(result.message.key.id)
		// survives the real protobuf round trip
		const wire = proto.Message.decode(proto.Message.encode(relayed[0].message).finish())
		const pack = wire.stickerPackMessage!
		expect(pack.name).toBe('DEX Pack')
		expect(pack.publisher).toBe('Shyam')
		expect(pack.stickerPackId).toBe(result.stickerPackId)
		expect(pack.stickers!.map(s => s.isAnimated)).toEqual([false, false, true])
		expect(pack.stickers![1]!.emojis).toEqual(['🐱'])
		expect(pack.directPath).toBe('/v/sticker-pack/1')
		expect(pack.thumbnailDirectPath).toBe('/v/thumbnail-sticker-pack/2')
		expect(wire.messageContextInfo!.messageSecret!.length).toBe(32)

		// what was uploaded decrypts back to a zip holding the stickers and the icon
		const zip = await decryptMedia(uploads[0]!.enc, pack.mediaKey!, 'sticker-pack')
		expect(Number(pack.fileLength)).toBe(zip.length)
		expect(Number(pack.stickerPackSize)).toBe(zip.length)
		expect(createHash('sha256').update(zip).digest().equals(Buffer.from(pack.fileSha256!))).toBe(true)
		expect(createHash('sha256').update(uploads[0]!.enc).digest().equals(Buffer.from(pack.fileEncSha256!))).toBe(true)
		const files = readZip(zip)
		expect([...files.keys()]).toEqual(['sticker-0.webp', 'sticker-1.webp', 'sticker-2.webp', 'tray.png'])
		expect(files.get('sticker-0.webp')!.equals(webp)).toBe(true)
		expect(files.get('sticker-1.webp')!.subarray(8, 12).toString()).toBe('WEBP')
		// the icon is a 252px png, encrypted with the pack's own key
		const icon = await decryptMedia(uploads[1]!.enc, pack.mediaKey!, 'thumbnail-sticker-pack')
		expect(icon.equals(files.get('tray.png')!)).toBe(true)
		const sharp = (await import('sharp')).default
		const meta = await sharp(icon).metadata()
		expect([meta.format, meta.width, meta.height]).toEqual(['png', 252, 252])
	})

	it('uses the icon given and refuses a bad pack without uploading', async () => {
		const { dex, uploads, relayed } = fakeSock()
		const icon = Buffer.from('my-icon')
		await dex.sendStickerPack('1@s.whatsapp.net', { name: 'n', publisher: 'p', stickers: [media('octopus.webp')], trayIcon: icon })
		const pack = relayed[0].message.stickerPackMessage
		const zip = await decryptMedia(uploads[0]!.enc, pack.mediaKey, 'sticker-pack')
		expect(readZip(zip).get('tray.png')!.equals(icon)).toBe(true)
		const fresh = fakeSock()
		await expect(fresh.dex.sendStickerPack('1@s.whatsapp.net', { name: 'n', publisher: '', stickers: [icon] } as any)).rejects.toMatchObject({ output: { statusCode: 400 } })
		await expect(fresh.dex.sendStickerPack('1@s.whatsapp.net', { name: 'n', publisher: 'p', stickers: [] })).rejects.toMatchObject({ output: { statusCode: 400 } })
		expect(fresh.uploads).toHaveLength(0)
	})
})

describe('group status', () => {
	it('wraps a photo as a group status and survives the protobuf round trip', async () => {
		const { dex, relayed } = fakeSock()
		const sent = await dex.sendGroupStatus('120@g.us', { image: media('cat.jpeg'), caption: 'hello group' })
		expect(relayed[0].jid).toBe('120@g.us')
		expect(relayed[0].opts.messageId).toBe(sent.key.id)
		const wire = proto.Message.decode(proto.Message.encode(relayed[0].message).finish())
		const inner = wire.groupStatusMessageV2!.message!
		expect(inner.imageMessage!.caption).toBe('hello group')
		const ctx = inner.imageMessage!.contextInfo!
		expect(ctx.isGroupStatus).toBe(true)
		expect(ctx.statusAttributions![0]!.type).toBe(proto.StatusAttribution.Type.GROUP_STATUS)
		expect(ctx.statusAttributions![0]!.groupStatus!.authorJid).toBe('555@lid')
		expect(ctx.featureEligibilities!.canReceiveMultiReact).toBe(true)
		expect(Buffer.from(wire.messageContextInfo!.messageSecret!).equals(Buffer.from(inner.messageContextInfo!.messageSecret!))).toBe(true)
		// the library's own unwrapping finds the photo again
		expect(normalizeMessageContent(wire)!.imageMessage!.caption).toBe('hello group')
	})

	it('sends text, keeps existing context and only goes to groups', async () => {
		const { dex, relayed } = fakeSock()
		await dex.sendGroupStatus('120@g.us', { text: 'good morning' }, { backgroundColor: '#FF0000' })
		const inner = relayed[0].message.groupStatusMessageV2.message
		expect(inner.extendedTextMessage?.text || inner.conversation).toBe('good morning')
		await expect(dex.sendGroupStatus('1@s.whatsapp.net', { text: 'x' })).rejects.toMatchObject({ output: { statusCode: 400 } })
		const built: any = buildGroupStatusMessage({ videoMessage: { contextInfo: { mentionedJid: ['a@s.whatsapp.net'] } } } as any, undefined)
		const ctx = built.groupStatusMessageV2.message.videoMessage.contextInfo
		expect(ctx.mentionedJid).toEqual(['a@s.whatsapp.net'])
		expect(ctx.statusAttributions).toEqual([])
	})
})

describe('SQLite session', () => {
	const dir = () => fs.mkdtemp(join(tmpdir(), 'dex-sqlite-'))

	it('keeps the login in one file across restarts', async () => {
		const folder = await dir()
		const file = join(folder, 'nested', 'auth.db')
		const first = await useSqliteAuthState(file)
		first.state.creds.me = { id: '911:1@s.whatsapp.net' }
		await first.saveCreds()
		await first.state.keys.set({ 'pre-key': { '1': { public: Buffer.from([1]), private: Buffer.from([2]) } }, session: { 'a.0': Buffer.from('s') as any } })
		first.close()
		first.close()

		const second = await useSqliteAuthState(file)
		expect(second.state.creds.me?.id).toBe('911:1@s.whatsapp.net')
		expect(Buffer.compare(second.state.creds.noiseKey.private, first.state.creds.noiseKey.private)).toBe(0)
		expect([...(await second.state.keys.get('pre-key', ['1']))['1']!.private]).toEqual([2])
		await second.state.keys.set({ session: { 'a.0': null } })
		expect((await second.state.keys.get('session', ['a.0']))['a.0']).toBeUndefined()
		expect(second.store.count()).toBe(2)
		await second.clear()
		expect(second.store.count()).toBe(0)
		second.close()
		expect((await fs.readdir(join(folder, 'nested'))).filter(f => f.endsWith('.db'))).toEqual(['auth.db'])
		await fs.rm(folder, { recursive: true, force: true })
	})

	it('copies an old session folder in once', async () => {
		const folder = await dir()
		const old = join(folder, 'auth_info')
		const multi = await useMultiFileAuthState(old)
		multi.state.creds.me = { id: '77:1@s.whatsapp.net' }
		await multi.saveCreds()
		await multi.state.keys.set({ 'pre-key': { '4': { a: 1 } as any } })

		const file = join(folder, 'auth.db')
		const moved = await useSqliteAuthState(file, { migrateFromFolder: old })
		expect(moved.state.creds.me?.id).toBe('77:1@s.whatsapp.net')
		expect((await moved.state.keys.get('pre-key', ['4']))['4']).toEqual({ a: 1 })
		moved.state.creds.me = { id: '88:1@s.whatsapp.net' }
		await moved.saveCreds()
		moved.close()
		// the database wins from now on, and a missing folder is not an error
		const again = await useSqliteAuthState(file, { migrateFromFolder: old })
		expect(again.state.creds.me?.id).toBe('88:1@s.whatsapp.net')
		again.close()
		const none = await useSqliteAuthState(join(folder, 'b.db'), { migrateFromFolder: join(folder, 'nope') })
		expect(none.state.creds.me).toBeUndefined()
		none.close()
		await fs.rm(folder, { recursive: true, force: true })
	})

	it('keeps bots apart and rejects a bad table name', async () => {
		const store = await sqliteKeyValueStore(':memory:')
		await store.set('a:creds', '1')
		await store.set('ab:creds', '2')
		await store.set('a%:x', '3')
		await store.clear!('a:')
		expect(store.count()).toBe(2)
		expect(await store.get('ab:creds')).toBe('2')
		expect(await store.get('missing')).toBeUndefined()
		store.close()
		await expect(sqliteKeyValueStore(':memory:', 'x; DROP')).rejects.toMatchObject({ output: { statusCode: 400 } })
	})
})
