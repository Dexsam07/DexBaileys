import { jest } from '@jest/globals'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { proto } from '../../../WAProto/index.js'
import {
	assertViewOnceDownloadable,
	buildStickerReaction,
	compareVersions,
	createSendQueue,
	createVersionStore,
	extractViewOnceContent,
	isSameUser,
	pickNewestVersion,
	resolveUserJids
} from '../../Utils'

const lookup = {
	getLIDForPN: async (pn: string) => (pn.startsWith('917384287404') ? '111222333@lid' : null),
	getPNForLID: async (lid: string) => (lid.startsWith('111222333') ? '917384287404@s.whatsapp.net' : null)
}

describe('sticker reaction', () => {
	const sticker = { url: 'https://mmg.whatsapp.net/x', mediaKey: Buffer.alloc(32, 1), mimetype: 'image/webp' }
	it('attaches the sticker to the target message', () => {
		const key = { remoteJid: '1203@g.us', id: 'ABC', fromMe: false, participant: '5@lid' }
		const m = proto.Message.decode(proto.Message.encode(proto.Message.create(buildStickerReaction(sticker, key))).finish())
		expect(m.stickerMessage!.url).toBe(sticker.url)
		const assoc = m.messageContextInfo!.messageAssociation!
		expect(assoc.associationType).toBe(proto.MessageAssociation.AssociationType.STICKER_ANNOTATION)
		expect(assoc.parentMessageKey).toMatchObject({ remoteJid: '1203@g.us', id: 'ABC', fromMe: false, participant: '5@lid' })
	})

	it('rejects a missing key or an unuploaded sticker', () => {
		expect(() => buildStickerReaction(sticker, { remoteJid: 'x@s.whatsapp.net' } as any)).toThrow(/key/)
		expect(() => buildStickerReaction({ mimetype: 'image/webp' }, { remoteJid: 'x@s.whatsapp.net', id: '1' })).toThrow(
			/uploaded/
		)
	})
})

describe('isSameUser', () => {
	it('matches number, device jid, bare digits and LID of one user', async () => {
		expect(await isSameUser('917384287404@s.whatsapp.net', '917384287404:12@s.whatsapp.net', lookup)).toBe(true)
		expect(await isSameUser('+91 73842 87404', '917384287404@s.whatsapp.net', lookup)).toBe(true)
		expect(await isSameUser('917384287404', '111222333@lid', lookup)).toBe(true)
		expect(await isSameUser('111222333:4@lid', '917384287404@s.whatsapp.net', lookup)).toBe(true)
		expect(await isSameUser('111222333@lid', '111222333:9@lid', lookup)).toBe(true)
	})

	it('does not match strangers or unknown LIDs', async () => {
		expect(await isSameUser('919999999999@s.whatsapp.net', '111222333@lid', lookup)).toBe(false)
		expect(await isSameUser('917384287404@s.whatsapp.net', '999@lid', lookup)).toBe(false)
		expect(await isSameUser('917384287404@s.whatsapp.net', '917384287405@s.whatsapp.net', lookup)).toBe(false)
		expect(await isSameUser(undefined, '111222333@lid', lookup)).toBe(false)
		expect(await isSameUser('', '', lookup)).toBe(false)
	})

	it('survives a failing lookup', async () => {
		const broken = {
			getLIDForPN: async () => {
				throw new Error('db down')
			},
			getPNForLID: async () => {
				throw new Error('db down')
			}
		}
		expect(await isSameUser('917384287404', '111222333@lid', broken)).toBe(false)
		expect(await resolveUserJids('917384287404', lookup)).toEqual({
			pn: '917384287404@s.whatsapp.net',
			lid: '111222333@lid'
		})
	})
})

describe('view once', () => {
	const image = { url: 'https://mmg.whatsapp.net/v', mediaKey: Buffer.alloc(32, 2), mimetype: 'image/jpeg', caption: 'hi' }
	it('finds wrapped, flagged and quoted view-once media', () => {
		expect(extractViewOnceContent({ viewOnceMessageV2: { message: { imageMessage: image } } })).toMatchObject({
			type: 'image',
			caption: 'hi',
			mimetype: 'image/jpeg'
		})
		expect(extractViewOnceContent({ viewOnceMessage: { message: { videoMessage: { ...image, mimetype: 'video/mp4' } } } })!.type).toBe(
			'video'
		)
		expect(
			extractViewOnceContent({ viewOnceMessageV2Extension: { message: { audioMessage: { url: 'u', mediaKey: Buffer.alloc(32) } } } })!
				.type
		).toBe('audio')
		expect(extractViewOnceContent({ imageMessage: { ...image, viewOnce: true } })!.type).toBe('image')
		const reply = {
			extendedTextMessage: {
				text: '.vv',
				contextInfo: { quotedMessage: { imageMessage: { ...image, viewOnce: true } } }
			}
		}
		expect(extractViewOnceContent(reply)!.message.imageMessage!.url).toBe(image.url)
		const replyWrapped = {
			extendedTextMessage: {
				text: '.vv',
				contextInfo: { quotedMessage: { viewOnceMessageV2: { message: { videoMessage: image } } } }
			}
		}
		expect(extractViewOnceContent(replyWrapped)!.type).toBe('video')
	})

	it('ignores ordinary media and text', () => {
		expect(extractViewOnceContent({ imageMessage: image })).toBeUndefined()
		expect(extractViewOnceContent({ conversation: 'hello' })).toBeUndefined()
		expect(extractViewOnceContent({ ephemeralMessage: { message: { imageMessage: image } } })).toBeUndefined()
		expect(extractViewOnceContent(undefined)).toBeUndefined()
	})

	it('explains a missing media key', () => {
		const placeholder = extractViewOnceContent({ viewOnceMessageV2: { message: { imageMessage: { mimetype: 'image/jpeg' } } } })!
		expect(() => assertViewOnceDownloadable(placeholder)).toThrow(/media key is missing/)
		expect(() => assertViewOnceDownloadable(extractViewOnceContent({ imageMessage: { ...image, viewOnce: true } })!)).not.toThrow()
	})
})

describe('version store', () => {
	it('orders versions', () => {
		expect(compareVersions([2, 3000, 5], [2, 3000, 4])).toBeGreaterThan(0)
		expect(compareVersions([2, 3000, 5], [2, 3000, 5])).toBe(0)
		expect(pickNewestVersion([2, 3000, 1], undefined, 'x', [2, 3000, 9], [2, 2999, 99])).toEqual([2, 3000, 9])
		expect(pickNewestVersion(undefined, [1, 2])).toBeUndefined()
	})

	it('never goes back to an older version', async () => {
		const dir = await fs.mkdtemp(join(tmpdir(), 'dexver-'))
		const file = join(dir, 'nested', 'version.json')
		let next: any = { version: [2, 3000, 50], isLatest: true }
		const store = createVersionStore({ file, bundled: [2, 3000, 10], fetchLatest: async () => next })
		expect(await store.get()).toEqual([2, 3000, 10])
		expect(await store.resolve()).toEqual([2, 3000, 50])
		expect(JSON.parse(await fs.readFile(file, 'utf8')).version).toEqual([2, 3000, 50])

		// the fetch falls back to the bundled (older) revision: keep the stored one
		next = { version: [2, 3000, 10], isLatest: false }
		expect(await store.resolve()).toEqual([2, 3000, 50])
		// the fetch throws: keep the stored one
		const offline = createVersionStore({
			file,
			bundled: [2, 3000, 10],
			fetchLatest: async () => {
				throw new Error('offline')
			}
		})
		expect(await offline.resolve()).toEqual([2, 3000, 50])
		// "restart": a new store reads the file
		expect(await createVersionStore({ file, bundled: [2, 3000, 10] }).get()).toEqual([2, 3000, 50])
		// an older answer marked latest still cannot downgrade
		next = { version: [2, 3000, 20], isLatest: true }
		expect(await store.resolve()).toEqual([2, 3000, 50])
		// corrupt file falls back to bundled
		await fs.writeFile(file, 'not json')
		expect(await createVersionStore({ file, bundled: [2, 3000, 10] }).get()).toEqual([2, 3000, 10])
		await fs.rm(dir, { recursive: true, force: true })
	})
})

describe('send queue', () => {
	const setup = (options = {}) => {
		let clock = 0
		const sent: { jid: string; at: number }[] = []
		const sock = {
			sendMessage: jest.fn(async (jid: string) => {
				sent.push({ jid, at: clock })
				if (jid === 'bad') throw new Error('boom')
				return { key: { id: String(sent.length) } } as any
			})
		}
		const queue = createSendQueue(sock, {
			now: () => clock,
			sleep: async (ms: number) => {
				clock += ms
			},
			random: () => 0,
			...options
		})
		return { queue, sent, sock }
	}

	it('keeps the global and the per-chat gap, in order', async () => {
		const { queue, sent } = setup({ minDelayMs: 1000, perChatDelayMs: 3000 })
		await Promise.all([queue.send('a', { text: '1' }), queue.send('b', { text: '2' }), queue.send('a', { text: '3' })])
		expect(sent).toEqual([
			{ jid: 'a', at: 0 },
			{ jid: 'b', at: 1000 },
			{ jid: 'a', at: 3000 }
		])
		expect(queue.size).toBe(0)
	})

	it('caps sends per minute', async () => {
		const { queue, sent } = setup({ minDelayMs: 0, perChatDelayMs: 0, maxPerMinute: 3 })
		await Promise.all(['a', 'b', 'c', 'd', 'e'].map(jid => queue.send(jid, { text: 'x' })))
		expect(sent.map(s => s.at)).toEqual([0, 0, 0, 60000, 60000])
	})

	it('one failure does not block the rest, and clear drops what is waiting', async () => {
		const { queue, sent } = setup({ minDelayMs: 10, perChatDelayMs: 10 })
		const failed = queue.send('bad', { text: 'x' })
		const ok = queue.send('a', { text: 'y' })
		await expect(failed).rejects.toThrow('boom')
		await expect(ok).resolves.toBeTruthy()

		const first = queue.send('a', { text: '1' })
		const second = queue.send('b', { text: '2' })
		const third = queue.send('c', { text: '3' })
		queue.clear()
		const results = await Promise.allSettled([first, second, third])
		expect(results.map(r => r.status)).toEqual(['rejected', 'rejected', 'rejected'])
		await queue.idle()
		expect(sent.map(s => s.jid)).toEqual(['bad', 'a'])
		await expect(queue.send('z', { text: 'after clear' })).resolves.toBeTruthy()
	})
})
