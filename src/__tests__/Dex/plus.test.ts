import { jest } from '@jest/globals'
import { EventEmitter } from 'events'
import { promises as fs, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { proto } from '../../../WAProto/index.js'
import { makeDexHelpers } from '../../Socket/dex'
import {
	addStickerExif,
	createHealthMonitor,
	createScheduler,
	generateWAMessageContent,
	getAggregateVotesInPollMessage,
	isAnimatedWebp,
	makeStickerWebp,
	migrateSession,
	normalizeMessageContent,
	parseNewsletterStatus,
	readStickerExif,
	typewriterFrames,
	useMultiFileAuthState,
	useSingleFileAuthState
} from '../../Utils'

const tmp = () => fs.mkdtemp(join(tmpdir(), 'dex-plus-'))
const content = (c: any) => generateWAMessageContent(c, { upload: jest.fn() as any } as any)

const fakeSock = (over: any = {}) => {
	const ev = new EventEmitter()
	const sent: any[] = []
	let n = 0
	const sock: any = {
		ev,
		user: { id: '911:1@s.whatsapp.net' },
		sent,
		sendMessage: jest.fn(async (jid: string, c: any) => {
			sent.push({ jid, content: c })
			return { key: { remoteJid: jid, fromMe: true, id: `M${++n}` }, message: {} }
		}),
		relayMessage: jest.fn(),
		waUploadToServer: jest.fn(),
		updateMediaMessage: jest.fn(),
		sendPresenceUpdate: jest.fn(async () => {}),
		groupMetadata: jest.fn(),
		readStatus: jest.fn(),
		reactToStatus: jest.fn(),
		executeUSyncQuery: jest.fn(),
		signalRepository: { lidMapping: { getLIDForPN: async () => null, getPNForLID: async () => '917384287404:2@s.whatsapp.net' } },
		...over
	}
	return { sock, dex: makeDexHelpers(sock, undefined as any) }
}

describe('sticker pack name', () => {
	it('tags a still sticker and can read the tag back', async () => {
		const { data } = await makeStickerWebp(readFileSync('Media/cat.jpeg'))
		const tagged = addStickerExif(data, { pack: 'DEX SHYAM TECH', author: 'Shyam', emojis: ['🔥'] })
		expect(tagged.readUInt32LE(4)).toBe(tagged.length - 8)
		expect(readStickerExif(tagged)).toMatchObject({ pack: 'DEX SHYAM TECH', author: 'Shyam', emojis: ['🔥'] })
		const sharp = (await import('sharp')).default
		const meta = await sharp(tagged).metadata()
		expect(meta.width).toBe(512)
		expect(meta.exif).toBeTruthy()
		// tagging twice replaces, never stacks
		const again = addStickerExif(tagged, { pack: 'B' })
		expect(readStickerExif(again)!.pack).toBe('B')
		expect(again.toString('latin1').split('EXIF').length).toBe(2)
	})

	it('keeps an animated sticker animated and rejects non-webp', async () => {
		const { data, isAnimated } = await makeStickerWebp(readFileSync('Media/ma_gif.mp4'))
		expect(isAnimated).toBe(true)
		const tagged = addStickerExif(data, { pack: 'P', author: 'A' })
		expect(isAnimatedWebp(tagged)).toBe(true)
		expect(readStickerExif(tagged)!.author).toBe('A')
		expect(() => addStickerExif(readFileSync('Media/cat.jpeg'), { pack: 'x' })).toThrow(/webp/)
	})

	it('sendSticker converts, tags and sends', async () => {
		const { sock, dex } = fakeSock()
		await dex.sendSticker('1@s.whatsapp.net', readFileSync('Media/cat.jpeg'), { pack: 'DEX', author: 'Shyam' })
		const sticker = sock.sent[0].content.sticker
		expect(readStickerExif(sticker)).toMatchObject({ pack: 'DEX', author: 'Shyam' })
		expect(sock.sent[0].content.isAnimated).toBe(false)
	})
})

describe('self destruct, typewriter, scheduler', () => {
	it('deletes the message after the time, or keeps it when cancelled', async () => {
		const { sock, dex } = fakeSock()
		const a = await dex.sendSelfDestruct('1@s.whatsapp.net', { text: 'secret' }, 0.05)
		expect(await a.done).toBe(true)
		expect(sock.sent[1].content).toEqual({ delete: a.message!.key })
		expect(a.cancel()).toBe(false)

		const b = await dex.sendSelfDestruct('1@s.whatsapp.net', { text: 'keep' }, 0.05)
		expect(b.cancel()).toBe(true)
		await new Promise(r => setTimeout(r, 90))
		expect(sock.sent).toHaveLength(3)
		await expect(dex.sendSelfDestruct('1@s.whatsapp.net', { text: 'x' }, 0)).rejects.toThrow()
	})

	it('typewriter grows by edits and ends on the full text', async () => {
		expect(typewriterFrames('one two three four', 4)).toEqual(['one', 'one two', 'one two three', 'one two three four'])
		expect(typewriterFrames('single', 5)).toEqual(['single'])
		const long = typewriterFrames(Array.from({ length: 100 }, (_, i) => `w${i}`).join(' '), 99)
		expect(long.length).toBeLessThanOrEqual(15)
		const { sock, dex } = fakeSock()
		await dex.sendTypewriter('1@s.whatsapp.net', 'DEX SHYAM TECH menu', { steps: 4, delayMs: 300 })
		expect(sock.sent[0].content).toEqual({ text: 'DEX' })
		expect(sock.sent.slice(1).every((s: any) => s.content.edit.id === 'M1')).toBe(true)
		expect(sock.sent[sock.sent.length - 1].content.text).toBe('DEX SHYAM TECH menu')
	})

	it('scheduler sends at the time, lists, cancels and refuses the past', async () => {
		const send = jest.fn(async () => 'ok')
		const sentJobs: string[] = []
		const s = createScheduler(send as any, { onSent: job => sentJobs.push(job.id) })
		const a = s.schedule('1@s.whatsapp.net', { text: 'a' }, 40)
		const b = s.schedule('1@s.whatsapp.net', { text: 'b' }, new Date(Date.now() + 5000))
		expect(s.list().map(j => j.id)).toEqual([a.id, b.id])
		expect(s.cancel(b.id)).toBe(true)
		expect(s.cancel(b.id)).toBe(false)
		expect(() => s.schedule('1@s.whatsapp.net', { text: 'c' }, new Date(Date.now() - 1000))).toThrow(/over/)
		expect(() => s.schedule('1@s.whatsapp.net', { text: 'c' }, 40 * 24 * 3600 * 1000)).toThrow(/24 days/)
		await new Promise(r => setTimeout(r, 90))
		expect(send).toHaveBeenCalledTimes(1)
		expect(sentJobs).toEqual([a.id])
		expect(s.list()).toHaveLength(0)
	})
})

describe('new polls and spoiler', () => {
	it('builds a quiz poll that survives the wire', async () => {
		const m = await content({ poll: { name: 'Capital?', values: ['Delhi', 'Mumbai'], correctAnswer: 'Delhi' } })
		const back = proto.Message.decode(proto.Message.encode(m).finish())
		expect(back.pollCreationMessageV5!.pollType).toBe(proto.Message.PollType.QUIZ)
		expect(back.pollCreationMessageV5!.correctAnswer!.optionName).toBe('Delhi')
		expect(back.pollCreationMessageV5!.selectableOptionsCount).toBe(1)
		expect(back.messageContextInfo!.messageSecret).toHaveLength(32)
		await expect(content({ poll: { name: 'q', values: ['a'], correctAnswer: 'z' } })).rejects.toThrow(/correctAnswer/)
	})

	it('builds a hidden-voter poll and still makes classic polls the old way', async () => {
		const end = new Date(Date.now() + 3600e3)
		const m = await content({ poll: { name: 'p', values: ['a', 'b'], hideVoter: true, canAddOption: true, endDate: end } })
		const back = proto.Message.decode(proto.Message.encode(m).finish())
		expect(back.pollCreationMessageV6!.hideParticipantName).toBe(true)
		expect(back.pollCreationMessageV6!.allowAddOption).toBe(true)
		expect(Number(back.pollCreationMessageV6!.endTime)).toBe(end.getTime())
		expect(getAggregateVotesInPollMessage({ message: back, pollUpdates: [] }).map(v => v.name)).toEqual(['a', 'b'])

		const classic = await content({ poll: { name: 'p', values: ['a', 'b'], selectableCount: 1 } })
		expect(classic.pollCreationMessageV3).toEqual({ name: 'p', selectableOptionsCount: 1, options: [{ optionName: 'a' }, { optionName: 'b' }] })
		expect((await content({ poll: { name: 'p', values: ['a', 'b'] } })).pollCreationMessage).toBeTruthy()
		await expect(content({ poll: { name: 'p', values: ['a'], endDate: 'x' as any } })).rejects.toThrow(/endDate/)
	})

	it('wraps spoiler content and unwraps it again', async () => {
		const m = await content({ text: 'hidden', spoiler: true })
		const back = proto.Message.decode(proto.Message.encode(m).finish())
		expect(back.spoilerMessage!.message!.extendedTextMessage!.text).toBe('hidden')
		expect(back.spoilerMessage!.message!.extendedTextMessage!.contextInfo!.isSpoiler).toBe(true)
		expect(normalizeMessageContent(back)!.extendedTextMessage!.text).toBe('hidden')
		expect((await content({ text: 'plain' })).spoilerMessage).toBeFalsy()
		const { sock, dex } = fakeSock()
		await dex.sendSpoiler('1@s.whatsapp.net', { text: 'x' })
		expect(sock.sent[0].content).toEqual({ text: 'x', spoiler: true })
	})
})

describe('usernames', () => {
	it('resolves a username once, caches it, and validates input', async () => {
		const executeUSyncQuery = jest.fn(async () => ({ list: [{ id: '555@lid', contact: true }], sideList: [] }))
		const { dex } = fakeSock({ executeUSyncQuery })
		const hit = await dex.resolveUsername('@Shyam.Tech')
		expect(hit).toEqual({ username: 'shyam.tech', jid: '917384287404@s.whatsapp.net', lid: '555@lid', pn: '917384287404@s.whatsapp.net', exists: true })
		await dex.resolveUsername('shyam.tech')
		expect(executeUSyncQuery).toHaveBeenCalledTimes(1)
		const query: any = (executeUSyncQuery.mock.calls[0] as any)[0]
		expect(query.protocols.map((p: any) => p.name)).toEqual(['contact'])
		expect(query.users[0].username).toBe('shyam.tech')
		await expect(dex.resolveUsername('a b')).rejects.toThrow(/valid/)
	})

	it('returns null for an unknown username and lists usernames of accounts', async () => {
		const none = fakeSock({ executeUSyncQuery: jest.fn(async () => ({ list: [], sideList: [] })) })
		expect(await none.dex.resolveUsername('nobody_here')).toBeNull()
		const some = fakeSock({
			executeUSyncQuery: jest.fn(async () => ({ list: [{ id: '1@s.whatsapp.net', username: 'dex' }, { id: '2@s.whatsapp.net', username: null }], sideList: [] }))
		})
		expect(await some.dex.fetchUsernames('1@s.whatsapp.net', '2@s.whatsapp.net')).toEqual([
			{ jid: '1@s.whatsapp.net', username: 'dex' },
			{ jid: '2@s.whatsapp.net', username: null }
		])
	})
})

describe('session move and health', () => {
	it('moves a folder session into one file and back without losing keys', async () => {
		const dir = await tmp()
		const folder = join(dir, 'auth')
		const a = await useMultiFileAuthState(folder)
		a.state.creds.me = { id: '933:4@s.whatsapp.net' }
		await a.saveCreds()
		await a.state.keys.set({
			'pre-key': { '7': { public: Buffer.alloc(32, 1), private: Buffer.alloc(32, 2) } },
			'sender-key': { '1203@g.us::9173::0': Buffer.from('sk') },
			'app-state-sync-key': { AAAA: { keyData: Buffer.alloc(32, 3) } as any }
		})
		await fs.writeFile(join(folder, 'notes.txt'), 'x')

		const file = join(dir, 'one.json')
		expect(await migrateSession({ folder }, { file })).toEqual({ keys: 3, skipped: [] })
		const b = await useSingleFileAuthState(file)
		expect(b.state.creds.me?.id).toBe('933:4@s.whatsapp.net')
		expect(Buffer.compare(b.state.creds.signedIdentityKey.private, a.state.creds.signedIdentityKey.private)).toBe(0)
		expect((await b.state.keys.get('sender-key', ['1203@g.us::9173::0']))['1203@g.us::9173::0']).toEqual(Buffer.from('sk'))
		expect((await b.state.keys.get('app-state-sync-key', ['AAAA']))['AAAA']).toBeInstanceOf(proto.Message.AppStateSyncKeyData)
		await expect(migrateSession({ folder }, { file })).rejects.toThrow(/already exists/)

		const folder2 = join(dir, 'auth2')
		await migrateSession({ sessionId: b.exportSessionId({ full: true }) }, { folder: folder2 })
		const c = await useMultiFileAuthState(folder2)
		expect(c.state.creds.me?.id).toBe('933:4@s.whatsapp.net')
		expect((await c.state.keys.get('pre-key', ['7']))['7']!.public).toEqual(Buffer.alloc(32, 1))
		expect((await c.state.keys.get('sender-key', ['1203@g.us::9173::0']))['1203@g.us::9173::0']).toEqual(Buffer.from('sk'))
		await expect(migrateSession({ folder: join(dir, 'missing') }, { file: join(dir, 'z.json') })).rejects.toThrow(/not found/)
	})

	it('reports connection health', () => {
		let t = 1000
		const ev = new EventEmitter()
		const h = createHealthMonitor(ev as any, { now: () => t })
		expect(h.report()).toMatchObject({ state: 'connecting', healthy: false, uptimeMs: 0 })
		ev.emit('connection.update', { connection: 'open' })
		t = 6000
		ev.emit('messages.upsert', { messages: [{}, {}] })
		t = 9000
		expect(h.report(5000)).toMatchObject({ state: 'open', healthy: true, uptimeMs: 8000, messagesReceived: 2, lastMessageAt: 6000 })
		t = 20000
		expect(h.report(5000).healthy).toBe(false)
		expect(h.report().healthy).toBe(true)
		ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 428 } } } })
		expect(h.report()).toMatchObject({ state: 'close', disconnects: 1, lastDisconnectCode: 428, healthy: false })
		h.stop()
		ev.emit('connection.update', { connection: 'open' })
		expect(h.report().state).toBe('close')
		const { dex } = fakeSock()
		expect(dex.health()).toMatchObject({ state: 'connecting', scheduled: 0 })
	})
})

describe('channel status', () => {
	it('reads a post with its counters, a reaction and a delete', () => {
		const body = proto.Message.encode({ conversation: 'new update' }).finish()
		const post = parseNewsletterStatus({
			tag: 'status',
			attrs: { id: 'S1', from: '120363406449026172@newsletter', server_id: '77', t: '1700000000', type: 'text' },
			content: [
				{ tag: 'plaintext', attrs: {}, content: body },
				{ tag: 'views_count', attrs: { count: '120' } },
				{ tag: 'reactions', attrs: {}, content: [{ tag: 'reaction', attrs: { code: '🔥', count: '9' } }] },
				{ tag: 'meta', attrs: { msg_edit_t: '1700000100' } }
			]
		})
		expect(post).toMatchObject({
			id: '120363406449026172@newsletter',
			messageId: 'S1',
			server_id: '77',
			timestamp: 1700000000,
			revoked: false,
			viewsCount: 120,
			reactions: [{ code: '🔥', count: 9 }],
			editedAt: 1700000100
		})
		expect(post.message!.conversation).toBe('new update')

		const reaction = parseNewsletterStatus({
			tag: 'status',
			attrs: { id: 'S2', from: '1@newsletter', type: 'reaction' },
			content: [{ tag: 'reaction', attrs: { code: '❤️' } }]
		})
		expect(reaction).toMatchObject({ reaction: '❤️', reactions: [], message: undefined })

		const gone = parseNewsletterStatus({
			tag: 'status',
			attrs: { id: 'S3', from: '1@newsletter', type: 'text', edit: '7' },
			content: [{ tag: 'plaintext', attrs: {}, content: body }]
		})
		expect(gone.revoked).toBe(true)
		expect(gone.message).toBeUndefined()
		expect(parseNewsletterStatus({ tag: 'status', attrs: { from: '1@newsletter' } }).reactions).toEqual([])
	})
})
