import { EventEmitter } from 'events'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { proto } from '../../../WAProto/index.js'
import { makeDexHelpers } from '../../Socket/dex'
import { WAMessageStubType } from '../../Types'
import {
	createAutoStatus,
	createDeleteWatcher,
	createGroupCache,
	exportSessionId,
	findGroupParticipant,
	getMessageText,
	groupAdminsOf,
	importSessionId,
	initAuthCreds,
	serializeMessage,
	typingDelayFor,
	useSingleFileAuthState
} from '../../Utils'

const tmpFile = async () => join(await fs.mkdtemp(join(tmpdir(), 'dex-auth-')), 'nested', 'session.json')
const group = (id = '1203@g.us') => ({
	id,
	subject: 'G',
	participants: [
		{ id: '111@lid', phoneNumber: '917384287404@s.whatsapp.net', admin: 'superadmin' as const },
		{ id: '222@lid', admin: null },
		{ id: '333@lid', admin: 'admin' as const }
	]
})

describe('single file session', () => {
	it('survives a restart with creds and keys intact', async () => {
		const file = await tmpFile()
		const a = await useSingleFileAuthState(file, { saveDelayMs: 5 })
		a.state.creds.me = { id: '911:1@s.whatsapp.net', name: 'x' }
		await a.saveCreds()
		await a.state.keys.set({
			'pre-key': { '5': { public: Buffer.alloc(32, 1), private: Buffer.alloc(32, 2) } },
			'app-state-sync-key': { k1: { keyData: Buffer.alloc(32, 3) } as any }
		})
		await a.flush()

		const b = await useSingleFileAuthState(file)
		expect(b.state.creds.me?.id).toBe('911:1@s.whatsapp.net')
		expect(Buffer.compare(b.state.creds.noiseKey.private, a.state.creds.noiseKey.private)).toBe(0)
		const pre = await b.state.keys.get('pre-key', ['5', 'nope'])
		expect(Buffer.isBuffer(pre['5']!.public)).toBe(true)
		expect(pre['nope']).toBeUndefined()
		const sync = await b.state.keys.get('app-state-sync-key', ['k1'])
		expect(sync['k1']).toBeInstanceOf(proto.Message.AppStateSyncKeyData)

		await b.state.keys.set({ 'pre-key': { '5': null as any } })
		await b.flush()
		const c = await useSingleFileAuthState(file)
		expect((await c.state.keys.get('pre-key', ['5']))['5']).toBeUndefined()
		expect((await fs.readdir(join(file, '..'))).filter(f => f.endsWith('.tmp'))).toHaveLength(0)
	})

	it('restores from a session id when the file is gone, and prefers the file after that', async () => {
		const first = await useSingleFileAuthState(await tmpFile())
		first.state.creds.me = { id: '922:3@s.whatsapp.net' }
		await first.state.keys.set({ 'pre-key': { '9': { public: Buffer.alloc(32, 7), private: Buffer.alloc(32, 8) } } })
		const small = first.exportSessionId()
		const full = first.exportSessionId({ full: true })
		expect(small.startsWith('DEX~')).toBe(true)
		expect(importSessionId(small).keys).toEqual({})

		const file = await tmpFile()
		const restored = await useSingleFileAuthState(file, { sessionId: full })
		expect(restored.state.creds.me?.id).toBe('922:3@s.whatsapp.net')
		expect((await restored.state.keys.get('pre-key', ['9']))['9']).toBeTruthy()
		expect(JSON.parse(await fs.readFile(file, 'utf-8')).creds.me.id).toBe('922:3@s.whatsapp.net')

		const other = exportSessionId(initAuthCreds())
		const again = await useSingleFileAuthState(file, { sessionId: other })
		expect(again.state.creds.me?.id).toBe('922:3@s.whatsapp.net')
	})

	it('accepts a plain base64 creds.json and rejects rubbish', async () => {
		const creds = initAuthCreds()
		const { BufferJSON } = await import('../../Utils')
		const plain = Buffer.from(JSON.stringify(creds, BufferJSON.replacer)).toString('base64')
		expect(Buffer.compare(importSessionId('BOT~' + plain).creds.noiseKey.public, creds.noiseKey.public)).toBe(0)
		expect(() => importSessionId('DEX~not-a-session')).toThrow(/damaged|login/)
		expect(() => importSessionId('')).toThrow(/empty/)
		const file = await tmpFile()
		await fs.mkdir(join(file, '..'), { recursive: true })
		await fs.writeFile(file, '{broken')
		await expect(useSingleFileAuthState(file)).rejects.toThrow(/damaged/)
	})
})

describe('group cache', () => {
	it('fetches once, shares in-flight requests and expires', async () => {
		let time = 0
		let calls = 0
		const cache = createGroupCache({ ttlMs: 1000, now: () => time, fetch: async id => (calls++, group(id) as any) })
		const [a, b] = await Promise.all([cache.get('1203@g.us'), cache.get('1203@g.us')])
		expect(a).toBe(b)
		await cache.get('1203@g.us')
		expect(calls).toBe(1)
		expect(cache.lookup('1203@g.us')).toBeTruthy()
		time = 1001
		expect(cache.lookup('1203@g.us')).toBeUndefined()
		await cache.get('1203@g.us')
		expect(calls).toBe(2)
		await cache.get('1203@g.us', true)
		expect(calls).toBe(3)
	})

	it('follows participant and subject events', async () => {
		const ev = new EventEmitter()
		const cache = createGroupCache({ fetch: async id => group(id) as any })
		const unbind = cache.bind(ev)
		await cache.get('1203@g.us')
		ev.emit('group-participants.update', { id: '1203@g.us', participants: [{ id: '444@lid' }], action: 'add' })
		ev.emit('group-participants.update', { id: '1203@g.us', participants: [{ id: '222@lid' }], action: 'promote' })
		ev.emit('group-participants.update', { id: '1203@g.us', participants: [{ id: '333@lid' }], action: 'demote' })
		ev.emit('group-participants.update', { id: '1203@g.us', participants: [{ id: '917384287404@s.whatsapp.net' }], action: 'remove' })
		ev.emit('groups.update', [{ id: '1203@g.us', subject: 'New' }, { id: 'unknown@g.us', subject: 'x' }])
		const g = cache.lookup('1203@g.us')!
		expect(g.participants.map(p => p.id)).toEqual(['222@lid', '333@lid', '444@lid'])
		expect(groupAdminsOf(g).map(p => p.id)).toEqual(['222@lid'])
		expect(g.subject).toBe('New')
		expect(cache.size()).toBe(1)
		unbind()
		ev.emit('groups.update', [{ id: '1203@g.us', subject: 'Later' }])
		expect(cache.lookup('1203@g.us')!.subject).toBe('New')
	})

	it('keeps at most `max` groups and finds members by number or LID', async () => {
		const cache = createGroupCache({ max: 2, fetch: async id => group(id) as any })
		for (const id of ['a@g.us', 'b@g.us', 'c@g.us']) await cache.get(id)
		expect(cache.size()).toBe(2)
		expect(cache.lookup('a@g.us')).toBeUndefined()
		expect(findGroupParticipant(group(), '+91 73842 87404')!.id).toBe('111@lid')
		expect(findGroupParticipant(group(), '333:4@lid')!.id).toBe('333@lid')
		expect(findGroupParticipant(group(), '999@lid')).toBeUndefined()
	})
})

const fakeSock = () => {
	const sent: any[] = []
	const presence: string[] = []
	const ev = new EventEmitter()
	let metaCalls = 0
	const sock: any = {
		ev,
		user: { id: '911:2@s.whatsapp.net', lid: '333:2@lid' },
		signalRepository: {
			lidMapping: {
				getLIDForPN: async (pn: string) => (pn.startsWith('918000000000') ? '222@lid' : null),
				getPNForLID: async () => null
			}
		},
		groupMetadata: async (id: string) => (metaCalls++, group(id)),
		sendPresenceUpdate: async (type: string) => void presence.push(type),
		sendMessage: async (jid: string, content: any, options: any) => (sent.push({ jid, content, options }), { key: { id: 'S' } }),
		readStatus: async (key: any, author: string) => void sent.push({ read: key.id, author }),
		reactToStatus: async (key: any, emoji: string) => void sent.push({ react: key.id, emoji })
	}
	return { sock, ev, sent, presence, metaCalls: () => metaCalls, dex: makeDexHelpers(sock, undefined as any) }
}

describe('group helpers on the socket', () => {
	it('answers admin questions from one fetch', async () => {
		const { dex, metaCalls } = fakeSock()
		expect(await dex.groupAdmins('1203@g.us')).toEqual(['111@lid', '333@lid'])
		expect(await dex.isGroupAdmin('1203@g.us', '917384287404')).toBe(true)
		expect(await dex.isGroupAdmin('1203@g.us', '222@lid')).toBe(false)
		expect(await dex.isGroupAdmin('1203@g.us', '918000000000')).toBe(false)
		expect(await dex.isBotAdmin('1203@g.us')).toBe(true)
		expect(metaCalls()).toBe(1)
	})

	it('tags everybody, or only the admins', async () => {
		const { dex, sent } = fakeSock()
		await dex.tagAll('1203@g.us', 'Hello')
		expect(sent[0].content).toEqual({ text: 'Hello', mentions: ['111@lid', '222@lid', '333@lid'] })
		await dex.tagAll('1203@g.us', 'Admins', { adminsOnly: true, showList: true })
		expect(sent[1].content.mentions).toEqual(['111@lid', '333@lid'])
		expect(sent[1].content.text).toBe('Admins\n@111\n@333')
	})
})

describe('message helper', () => {
	const tools = { download: async () => Buffer.from('file') }
	it('reads text from every kind of message', () => {
		expect(getMessageText({ conversation: 'hi' })).toBe('hi')
		expect(getMessageText({ ephemeralMessage: { message: { extendedTextMessage: { text: '.menu' } } } })).toBe('.menu')
		expect(getMessageText({ imageMessage: { caption: 'cap' } })).toBe('cap')
		expect(getMessageText({ buttonsResponseMessage: { selectedButtonId: '.ping' } })).toBe('.ping')
		expect(getMessageText({ listResponseMessage: { singleSelectReply: { selectedRowId: '.row' } } })).toBe('.row')
		expect(
			getMessageText({ interactiveResponseMessage: { nativeFlowResponseMessage: { paramsJson: '{"id":".owner"}' } } })
		).toBe('.owner')
		expect(getMessageText({ stickerMessage: {} })).toBe('')
		expect(getMessageText(undefined)).toBe('')
	})

	it('gives sender, quoted message and reply helpers', async () => {
		const { sock, sent } = fakeSock()
		const msg: any = {
			key: { remoteJid: '1203@g.us', id: 'M1', fromMe: false, participant: '222:5@lid' },
			pushName: 'Ravi',
			message: {
				extendedTextMessage: {
					text: '.vv @x',
					contextInfo: {
						stanzaId: 'Q1',
						participant: '333@lid',
						mentionedJid: ['111@lid'],
						quotedMessage: { imageMessage: { caption: 'old' } }
					}
				}
			}
		}
		const m = serializeMessage(sock, msg, tools)
		expect(m).toMatchObject({ chat: '1203@g.us', isGroup: true, sender: '222@lid', pushName: 'Ravi', text: '.vv @x', type: 'extendedTextMessage', isMedia: false })
		expect(m.mentions).toEqual(['111@lid'])
		expect(m.quoted).toMatchObject({ id: 'Q1', sender: '333@lid', fromMe: true, text: 'old', isMedia: true, type: 'imageMessage' })
		expect(m.quoted!.key).toEqual({ remoteJid: '1203@g.us', id: 'Q1', fromMe: true, participant: '333@lid' })
		expect((await m.quoted!.download()).toString()).toBe('file')
		await m.reply('ok')
		await m.react('🔥')
		await m.send({ text: 'plain' })
		expect(sent[0]).toMatchObject({ jid: '1203@g.us', content: { text: 'ok' }, options: { quoted: msg } })
		expect(sent[1].content).toEqual({ react: { text: '🔥', key: msg.key } })
		expect(sent[2].options).toEqual({})
	})

	it('handles a private chat and my own message', () => {
		const { sock } = fakeSock()
		const dm = serializeMessage(sock, { key: { remoteJid: '918@s.whatsapp.net', id: 'A', fromMe: false }, message: { conversation: 'yo' } } as any, tools)
		expect(dm).toMatchObject({ isGroup: false, sender: '918@s.whatsapp.net', quoted: undefined })
		const mine = serializeMessage(sock, { key: { remoteJid: '918@s.whatsapp.net', id: 'B', fromMe: true }, message: { conversation: 'me' } } as any, tools)
		expect(mine.sender).toBe('911@s.whatsapp.net')
	})
})

describe('anti-delete', () => {
	const upsert = (id: string, text: string, extra: any = {}) => ({
		messages: [{ key: { remoteJid: '1203@g.us', id, fromMe: false, participant: '222@lid' }, message: { conversation: text }, ...extra }]
	})
	const revoke = (id: string, fromMe = false) => [
		{
			key: { remoteJid: '1203@g.us', id, fromMe: false, participant: '222@lid' },
			update: { message: null, messageStubType: WAMessageStubType.REVOKE, key: { remoteJid: '1203@g.us', id: 'REV', fromMe, participant: '222@lid' } }
		}
	]

	it('hands back the original of a deleted message', async () => {
		const ev = new EventEmitter()
		const got: any[] = []
		const watcher = createDeleteWatcher(ev as any, e => void got.push(e))
		ev.emit('messages.upsert', upsert('A', 'secret'))
		ev.emit('messages.update', [{ key: { remoteJid: '1203@g.us', id: 'A' }, update: { status: 3 } }])
		ev.emit('messages.update', revoke('A'))
		ev.emit('messages.update', revoke('NEVER-SEEN'))
		ev.emit('messages.update', revoke('A', true))
		await watcher.idle()
		expect(got).toHaveLength(2)
		expect(got[0]).toMatchObject({ chat: '1203@g.us', deletedBy: '222@lid' })
		expect(got[0].message.message.conversation).toBe('secret')
		expect(got[1].message).toBeUndefined()
		expect(watcher.size()).toBe(0)
	})

	it('forgets old messages and respects the size limit', async () => {
		const ev = new EventEmitter()
		let time = 0
		const got: any[] = []
		const watcher = createDeleteWatcher(ev as any, e => void got.push(e), { max: 2, ttlMs: 1000, now: () => time })
		for (const id of ['A', 'B', 'C']) ev.emit('messages.upsert', upsert(id, id))
		expect(watcher.size()).toBe(2)
		time = 2000
		ev.emit('messages.update', revoke('C'))
		await watcher.idle()
		expect(got[0].message).toBeUndefined()
		watcher.stop()
		ev.emit('messages.update', revoke('B'))
		await watcher.idle()
		expect(got).toHaveLength(1)
	})
})

describe('typing and status', () => {
	it('waits longer for longer text, inside the limits', () => {
		expect(typingDelayFor('hi')).toBe(600)
		expect(typingDelayFor({ text: 'x'.repeat(50) })).toBe(2000)
		expect(typingDelayFor({ text: 'x'.repeat(5000) })).toBe(5000)
		expect(typingDelayFor({ text: 'x' }, { typingMs: 0 })).toBe(0)
	})

	it('shows typing, pauses, then sends', async () => {
		const { dex, sent, presence } = fakeSock()
		await dex.sendWithTyping('918@s.whatsapp.net', { text: 'hello' }, { typingMs: 5 })
		expect(presence).toEqual(['composing', 'paused'])
		expect(sent[0]).toMatchObject({ content: { text: 'hello' }, options: {} })
		await dex.sendWithTyping('918@s.whatsapp.net', { audio: Buffer.alloc(1) } as any, { typingMs: 1 })
		expect(presence[2]).toBe('recording')
	})

	it('views, reacts to and reports statuses, skipping ignored people', async () => {
		const { sock, ev, sent } = fakeSock()
		const seen: any[] = []
		const auto = createAutoStatus(sock, { react: ['🔥'], ignore: ['918111111111'], onStatus: s => void seen.push(s) }, { download: async () => Buffer.from('m') })
		const status = (id: string, participant: string, message: any, fromMe = false) => ({
			messages: [{ key: { remoteJid: 'status@broadcast', id, fromMe, participant }, message }]
		})
		ev.emit('messages.upsert', status('S1', '918222222222@s.whatsapp.net', { imageMessage: { caption: 'trip' } }))
		ev.emit('messages.upsert', status('S2', '918111111111@s.whatsapp.net', { conversation: 'no' }))
		ev.emit('messages.upsert', status('S3', '918222222222@s.whatsapp.net', { conversation: 'mine' }, true))
		ev.emit('messages.upsert', status('S4', '918222222222@s.whatsapp.net', { protocolMessage: {} }))
		ev.emit('messages.upsert', { messages: [{ key: { remoteJid: '1203@g.us', id: 'G' }, message: { conversation: 'x' } }] })
		await auto.idle()
		expect(sent).toEqual([{ read: 'S1', author: '918222222222@s.whatsapp.net' }, { react: 'S1', emoji: '🔥' }])
		expect(seen[0]).toMatchObject({ author: '918222222222@s.whatsapp.net', text: 'trip', isMedia: true, type: 'imageMessage' })
		auto.stop()
		ev.emit('messages.upsert', status('S5', '918222222222@s.whatsapp.net', { conversation: 'later' }))
		await auto.idle()
		expect(sent).toHaveLength(2)
	})
})
