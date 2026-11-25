import { EventEmitter } from 'events'
import { readFileSync } from 'fs'
import { join } from 'path'
import { makeDexHelpers } from '../../Socket/dex'
import { createReactionTap, isAnimatedWebp, isWebp, makeStickerWebp } from '../../Utils'

const media = (name: string) => readFileSync(join(process.cwd(), 'Media', name))

const fakeSock = () => {
	const relayed: any[] = []
	let uploads = 0
	const ev = new EventEmitter()
	const sock: any = {
		ev,
		user: { id: '911@s.whatsapp.net' },
		signalRepository: { lidMapping: { getLIDForPN: async () => null, getPNForLID: async () => null } },
		waUploadToServer: async () => {
			uploads++
			return { mediaUrl: 'https://mmg.whatsapp.net/u' + uploads, directPath: '/u' + uploads }
		},
		relayMessage: async (jid: string, msg: any, o: any) => {
			relayed.push({ jid, msg })
			return o.messageId
		}
	}
	return { sock, ev, relayed, uploads: () => uploads, dex: makeDexHelpers(sock, undefined as any) }
}

const tap = (emoji: string, fromMe = true, extra: any = {}) => [
	{
		key: { remoteJid: '1203@g.us', id: 'TARGET', fromMe: false, participant: '5@lid' },
		reaction: { text: emoji, key: { remoteJid: '1203@g.us', id: 'R', fromMe, participant: fromMe ? '911@s.whatsapp.net' : '7@lid' }, ...extra }
	}
]

describe('makeStickerWebp', () => {
	it('keeps a still photo still', async () => {
		const out = await makeStickerWebp(media('cat.jpeg'))
		expect(isWebp(out.data)).toBe(true)
		expect(out.isAnimated).toBe(false)
	})

	it('turns a short video into an animated webp under the size limit', async () => {
		const out = await makeStickerWebp(media('ma_gif.mp4'))
		expect(isWebp(out.data)).toBe(true)
		expect(isAnimatedWebp(out.data)).toBe(true)
		expect(out.isAnimated).toBe(true)
		expect(out.data.length).toBeLessThanOrEqual(900 * 1024)
	}, 60_000)

	it('passes a ready webp through and reads its animation flag', async () => {
		const still = media('octopus.webp')
		expect((await makeStickerWebp(still)).data).toBe(still)
		expect(isAnimatedWebp(still)).toBe(false)
		expect(isAnimatedWebp(Buffer.from('not a webp at all'))).toBe(false)
	})

	it('explains a missing ffmpeg', async () => {
		await expect(makeStickerWebp(media('ma_gif.mp4'), { ffmpegPath: '/nonexistent/ffmpeg' })).rejects.toThrow(/ffmpeg is needed/)
	})
})

describe('sendStickerReaction with moving stickers', () => {
	it('marks an animated sticker as animated and a photo as still', async () => {
		const { dex, relayed } = fakeSock()
		const moving = (await makeStickerWebp(media('ma_gif.mp4'))).data
		await dex.sendStickerReaction({ remoteJid: '1203@g.us', id: 'T' }, [moving, media('cat.jpeg')], { count: 2 })
		expect(relayed[0].msg.stickerMessage.isAnimated).toBe(true)
		expect(relayed[1].msg.stickerMessage.isAnimated).toBe(false)
	}, 60_000)

	it('converts a raw video buffer on its own', async () => {
		const { dex, relayed } = fakeSock()
		await dex.sendStickerReaction({ remoteJid: '1203@g.us', id: 'T' }, media('ma_gif.mp4'))
		expect(relayed[0].msg.stickerMessage.isAnimated).toBe(true)
	}, 60_000)

	it('uploads the same buffer only once across calls', async () => {
		const { dex, uploads } = fakeSock()
		const sticker = media('octopus.webp')
		await dex.sendStickerReaction({ remoteJid: '1203@g.us', id: 'A' }, sticker, { count: 3 })
		await dex.sendStickerReaction({ remoteJid: '1203@g.us', id: 'B' }, sticker, { count: 3 })
		expect(uploads()).toBe(1)
	})
})

describe('reaction tap', () => {
	it('reacts with stickers when the linked account taps an emoji', async () => {
		const { dex, ev, relayed } = fakeSock()
		const tapper = dex.stickerReactOnTap(media('octopus.webp'), { count: 4 })
		ev.emit('messages.reaction', tap('🔥'))
		await tapper.idle()
		expect(relayed).toHaveLength(4)
		expect(relayed[0].msg.messageContextInfo.messageAssociation.parentMessageKey).toMatchObject({ id: 'TARGET', participant: '5@lid' })
	})

	it('ignores strangers, removed reactions, other emoji and old reactions', async () => {
		const ev = new EventEmitter()
		const seen: string[] = []
		const tapper = createReactionTap(ev as any, e => void seen.push(e.emoji), { emoji: ['🔥'], cooldownMs: 0, now: () => 1_000_000 })
		ev.emit('messages.reaction', tap('🔥', false))
		ev.emit('messages.reaction', tap(''))
		ev.emit('messages.reaction', tap('👍'))
		ev.emit('messages.reaction', tap('🔥', true, { senderTimestampMs: 1_000_000 - 61_000 }))
		ev.emit('messages.reaction', tap('🔥', true, { senderTimestampMs: 1_000_000 - 1000 }))
		await tapper.idle()
		expect(seen).toEqual(['🔥'])
	})

	it('applies the cooldown, a custom allow rule and stop()', async () => {
		const ev = new EventEmitter()
		let time = 10_000
		const seen: string[] = []
		const tapper = createReactionTap(ev as any, e => void seen.push(e.reactor), {
			allow: e => e.reactor === '7@lid',
			cooldownMs: 3000,
			now: () => time
		})
		ev.emit('messages.reaction', tap('🔥', false))
		ev.emit('messages.reaction', tap('🔥', false))
		await tapper.idle()
		expect(seen).toEqual(['7@lid'])
		time += 3001
		ev.emit('messages.reaction', tap('🔥', false))
		ev.emit('messages.reaction', tap('🔥', true))
		await tapper.idle()
		expect(seen).toHaveLength(2)
		tapper.stop()
		time += 5000
		ev.emit('messages.reaction', tap('🔥', false))
		await tapper.idle()
		expect(seen).toHaveLength(2)
	})

	it('reports a failing handler instead of throwing', async () => {
		const ev = new EventEmitter()
		const errors: unknown[] = []
		const tapper = createReactionTap(ev as any, () => { throw new Error('boom') }, { onError: e => errors.push(e) })
		ev.emit('messages.reaction', tap('🔥'))
		await tapper.idle()
		expect(errors).toHaveLength(1)
	})
})
