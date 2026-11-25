import { Boom } from '@hapi/boom'
import { spawn } from 'child_process'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
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

const isRiffWebp = (data: Uint8Array) =>
	data.length >= 16 &&
	Buffer.from(data.subarray(0, 4)).toString('latin1') === 'RIFF' &&
	Buffer.from(data.subarray(8, 12)).toString('latin1') === 'WEBP'

/** true when `data` is a webp file */
export const isWebp = (data: Uint8Array | null | undefined): boolean => !!data && isRiffWebp(data)

/** true when `data` is a webp file that moves (animation flag or ANIM / ANMF chunk) */
export const isAnimatedWebp = (data: Uint8Array | null | undefined): boolean => {
	if (!data || !isRiffWebp(data)) return false
	const view = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
	let offset = 12
	while (offset + 8 <= view.length) {
		const id = view.toString('latin1', offset, offset + 4)
		const size = view.readUInt32LE(offset + 4)
		if (id === 'ANIM' || id === 'ANMF') return true
		if (id === 'VP8X' && offset + 8 < view.length && (view[offset + 8]! & 0x02) !== 0) return true
		offset += 8 + size + (size % 2)
	}

	return false
}

export type StickerWebpOptions = {
	/** width and height of the sticker (default 512) */
	size?: number
	/** only the first seconds of a video / GIF are used (default 6) */
	maxSeconds?: number
	/** frames per second for a video (default 12) */
	fps?: number
	/** webp quality 1 to 100 (default 60) */
	quality?: number
	/** the result is squeezed until it is below this size (default 900 KB) */
	maxBytes?: number
	/** ffmpeg binary (default "ffmpeg") */
	ffmpegPath?: string
}

type MediaKind = 'webp' | 'gif' | 'image' | 'video'

const sniffMedia = (data: Buffer): MediaKind => {
	if (isRiffWebp(data)) return 'webp'
	const head = data.toString('latin1', 0, 6)
	if (head === 'GIF87a' || head === 'GIF89a') return 'gif'
	if (data[0] === 0xff && data[1] === 0xd8) return 'image'
	if (data.toString('latin1', 1, 4) === 'PNG') return 'image'
	return 'video'
}

const runFfmpeg = (binary: string, args: string[]) =>
	new Promise<void>((resolve, reject) => {
		const child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'] })
		let stderr = ''
		child.stderr.on('data', chunk => {
			stderr = (stderr + chunk).slice(-600)
		})
		child.on('error', () =>
			reject(new Boom('ffmpeg is needed to turn a video into an animated sticker', { statusCode: 501 }))
		)
		child.on('close', code =>
			code === 0 ? resolve() : reject(new Boom(`ffmpeg could not convert the video: ${stderr.trim()}`, { statusCode: 422 }))
		)
	})

/**
 * Turn a photo, GIF, animated webp or short video into a sticker webp.
 * Moving input stays moving. Photos / GIFs need the optional `sharp` package,
 * videos need `ffmpeg` on the host.
 */
export const makeStickerWebp = async (
	input: Buffer,
	options: StickerWebpOptions = {}
): Promise<{ data: Buffer; isAnimated: boolean }> => {
	if (!Buffer.isBuffer(input) || !input.length) {
		throw new Boom('makeStickerWebp needs the media as a Buffer', { statusCode: 400 })
	}

	const size = options.size ?? 512
	const maxBytes = options.maxBytes ?? 900 * 1024
	const maxSeconds = options.maxSeconds ?? 6
	const kind = sniffMedia(input)

	if (kind === 'webp' && input.length <= maxBytes) {
		return { data: input, isAnimated: isAnimatedWebp(input) }
	}

	if (kind === 'video') {
		const base = join(tmpdir(), `dex-sticker-${Date.now()}-${Math.random().toString(36).slice(2)}`)
		const source = `${base}.bin`
		const target = `${base}.webp`
		try {
			await fs.writeFile(source, input)
			let fps = options.fps ?? 12
			let quality = options.quality ?? 60
			let data: Buffer = Buffer.alloc(0)
			for (let attempt = 0; attempt < 4; attempt++) {
				const filter =
					`fps=${fps},scale=${size}:${size}:force_original_aspect_ratio=decrease,` +
					`pad=${size}:${size}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`
				await runFfmpeg(options.ffmpegPath ?? 'ffmpeg', [
					'-y', '-t', String(maxSeconds), '-i', source, '-an', '-vf', filter,
					'-c:v', 'libwebp', '-loop', '0', '-q:v', String(quality), '-compression_level', '4', target
				])
				data = await fs.readFile(target)
				if (data.length <= maxBytes) break
				fps = Math.max(6, fps - 3)
				quality = Math.max(15, quality - 15)
			}

			if (data.length > maxBytes) {
				throw new Boom('the video is too long or too detailed for a sticker', { statusCode: 413 })
			}

			return { data, isAnimated: isAnimatedWebp(data) }
		} finally {
			await fs.rm(source, { force: true }).catch(() => {})
			await fs.rm(target, { force: true }).catch(() => {})
		}
	}

	const sharp = await import('sharp').then(
		mod => (mod as any).default ?? mod,
		() => {
			throw new Boom('the "sharp" package is needed to turn a photo or GIF into a sticker', { statusCode: 501 })
		}
	)
	const animated = kind === 'gif' || (kind === 'webp' && isAnimatedWebp(input))
	let quality = options.quality ?? 60
	let data: Buffer = Buffer.alloc(0)
	for (let attempt = 0; attempt < 4; attempt++) {
		data = await sharp(input, { animated })
			.resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
			.webp({ quality })
			.toBuffer()
		if (data.length <= maxBytes) break
		quality = Math.max(10, quality - 15)
	}

	if (data.length > maxBytes) {
		throw new Boom('the picture is too large for a sticker', { statusCode: 413 })
	}

	return { data, isAnimated: isAnimatedWebp(data) }
}

export type ReactionTapEvent = {
	/** the message that got the emoji */
	key: WAMessageKey
	/** the emoji */
	emoji: string
	/** who reacted */
	reactor: string
	/** true when the linked account itself reacted */
	fromMe: boolean
}

export type ReactionTapOptions = {
	/** only these emoji trigger the handler (default: any emoji) */
	emoji?: string | string[]
	/** who may trigger it (default: only the linked account itself) */
	allow?: (event: ReactionTapEvent) => boolean | Promise<boolean>
	/** ignore taps that follow the last accepted one faster than this (default 3000 ms) */
	cooldownMs?: number
	/** ignore reactions older than this, e.g. after a reconnect (default 60000 ms) */
	maxAgeMs?: number
	onError?: (error: unknown, event: ReactionTapEvent) => void
	/** for tests */
	now?: () => number
}

type ReactionEmitter = {
	on: (event: 'messages.reaction', listener: (items: { key: WAMessageKey; reaction: proto.IReaction }[]) => void) => void
	off: (event: 'messages.reaction', listener: (items: { key: WAMessageKey; reaction: proto.IReaction }[]) => void) => void
}

/**
 * Calls `handler` when somebody puts an emoji on a message, so "tap an emoji"
 * can be used as a shortcut for a command. Removed reactions are ignored.
 */
export const createReactionTap = (
	ev: ReactionEmitter,
	handler: (event: ReactionTapEvent) => unknown,
	options: ReactionTapOptions = {}
) => {
	const wanted = options.emoji ? new Set(([] as string[]).concat(options.emoji)) : undefined
	const allow = options.allow ?? ((event: ReactionTapEvent) => event.fromMe)
	const cooldownMs = options.cooldownMs ?? 3000
	const maxAgeMs = options.maxAgeMs ?? 60_000
	const now = options.now ?? Date.now
	let lastAccepted = -Infinity
	let chain: Promise<void> = Promise.resolve()

	const handle = async (item: { key: WAMessageKey; reaction: proto.IReaction }) => {
		const emoji = item?.reaction?.text
		const reactionKey = item?.reaction?.key
		if (!emoji || !item.key?.remoteJid || !item.key.id) return
		if (wanted && !wanted.has(emoji)) return

		const sentAt = Number(item.reaction.senderTimestampMs ?? 0)
		if (sentAt > 0 && now() - sentAt > maxAgeMs) return

		const event: ReactionTapEvent = {
			key: item.key,
			emoji,
			reactor: reactionKey?.participant || reactionKey?.remoteJid || '',
			fromMe: !!reactionKey?.fromMe
		}
		try {
			if (!(await allow(event))) return
			if (now() - lastAccepted < cooldownMs) return
			lastAccepted = now()
			await handler(event)
		} catch (error) {
			options.onError?.(error, event)
		}
	}

	const listener = (items: { key: WAMessageKey; reaction: proto.IReaction }[]) => {
		for (const item of items || []) {
			chain = chain.then(() => handle(item))
		}
	}

	ev.on('messages.reaction', listener)
	return {
		stop: () => ev.off('messages.reaction', listener),
		/** resolves when every tap received so far has been handled */
		idle: () => chain
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
