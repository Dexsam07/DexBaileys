import { Boom } from '@hapi/boom'
import { randomBytes } from 'crypto'
import { promises as fs } from 'fs'
import { join } from 'path'
import { proto } from '../../WAProto/index.js'
import type { AnyMessageContent, BaileysEventMap, MiscMessageGenerationOptions, SignalDataTypeMap } from '../Types'
import { type BinaryNode, getBinaryNodeChild, getBinaryNodeChildren } from '../WABinary'
import { type SessionData, importSessionId, useSingleFileAuthState } from './dex-bot'
import { type DexKeyValueStore, useKeyValueAuthState } from './dex-store'
import { BufferJSON } from './generics'
import { useMultiFileAuthState } from './use-multi-file-auth-state'

/* ------------------------------------------------------------------ */
/* 1. sticker pack name / author                                       */
/* ------------------------------------------------------------------ */

export type StickerExifOptions = {
	/** pack name shown under the sticker */
	pack?: string
	/** author / publisher shown under the sticker */
	author?: string
	emojis?: string[]
	packId?: string
}

type Chunk = { id: string; data: Buffer }

const readChunks = (webp: Buffer): Chunk[] => {
	const chunks: Chunk[] = []
	let offset = 12
	while (offset + 8 <= webp.length) {
		const size = webp.readUInt32LE(offset + 4)
		const end = offset + 8 + size
		if (end > webp.length) break
		chunks.push({ id: webp.toString('latin1', offset, offset + 4), data: webp.subarray(offset + 8, end) })
		offset = end + (size % 2)
	}

	return chunks
}

const writeChunks = (chunks: Chunk[]) => {
	const parts: Buffer[] = []
	for (const chunk of chunks) {
		const head = Buffer.alloc(8)
		head.write(chunk.id, 0, 'latin1')
		head.writeUInt32LE(chunk.data.length, 4)
		parts.push(head, chunk.data)
		if (chunk.data.length % 2) parts.push(Buffer.alloc(1))
	}

	const body = Buffer.concat(parts)
	const riff = Buffer.alloc(12)
	riff.write('RIFF', 0, 'latin1')
	riff.writeUInt32LE(body.length + 4, 4)
	riff.write('WEBP', 8, 'latin1')
	return Buffer.concat([riff, body])
}

const simpleWebpSize = (chunk: Chunk) => {
	const d = chunk.data
	if (chunk.id === 'VP8 ' && d.length >= 10 && d[3] === 0x9d && d[4] === 0x01 && d[5] === 0x2a) {
		return { width: d.readUInt16LE(6) & 0x3fff, height: d.readUInt16LE(8) & 0x3fff, alpha: false }
	}

	if (chunk.id === 'VP8L' && d.length >= 5 && d[0] === 0x2f) {
		const bits = d.readUInt32LE(1)
		return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, alpha: !!((bits >> 28) & 1) }
	}

	return undefined
}

/** the EXIF block WhatsApp reads the sticker pack name and author from */
export const buildStickerExif = (options: StickerExifOptions) => {
	const json = Buffer.from(
		JSON.stringify({
			'sticker-pack-id': options.packId || randomBytes(16).toString('hex'),
			'sticker-pack-name': options.pack || '',
			'sticker-pack-publisher': options.author || '',
			emojis: options.emojis || []
		}),
		'utf-8'
	)
	const head = Buffer.from([
		0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16,
		0x00, 0x00, 0x00
	])
	head.writeUInt32LE(json.length, 14)
	return Buffer.concat([head, json])
}

/** Write a pack name and author into a webp sticker (still or animated). No extra package needed. */
export const addStickerExif = (webp: Buffer, options: StickerExifOptions): Buffer => {
	if (
		!Buffer.isBuffer(webp) ||
		webp.length < 20 ||
		webp.toString('latin1', 0, 4) !== 'RIFF' ||
		webp.toString('latin1', 8, 12) !== 'WEBP'
	) {
		throw new Boom('addStickerExif needs a webp sticker (use makeStickerWebp first)', { statusCode: 400 })
	}

	let chunks = readChunks(webp).filter(chunk => chunk.id !== 'EXIF')
	const first = chunks[0]
	if (!first) throw new Boom('the webp file is damaged', { statusCode: 400 })
	if (first.id === 'VP8X') {
		const header = Buffer.from(first.data)
		header[0] = header[0]! | 0x08
		chunks[0] = { id: 'VP8X', data: header }
	} else {
		const size = simpleWebpSize(first)
		if (!size) throw new Boom('this webp file cannot be tagged', { statusCode: 400 })
		const header = Buffer.alloc(10)
		header[0] = 0x08 | (size.alpha ? 0x10 : 0)
		header.writeUIntLE(size.width - 1, 4, 3)
		header.writeUIntLE(size.height - 1, 7, 3)
		chunks = [{ id: 'VP8X', data: header }, ...chunks]
	}

	const exif: Chunk = { id: 'EXIF', data: buildStickerExif(options) }
	const xmp = chunks.findIndex(chunk => chunk.id === 'XMP ')
	if (xmp >= 0) chunks.splice(xmp, 0, exif)
	else chunks.push(exif)
	return writeChunks(chunks)
}

/** read the pack name and author back from a sticker */
export const readStickerExif = (webp: Buffer): StickerExifOptions | undefined => {
	if (!Buffer.isBuffer(webp) || webp.length < 20 || webp.toString('latin1', 8, 12) !== 'WEBP') return undefined
	const exif = readChunks(webp).find(chunk => chunk.id === 'EXIF')?.data
	if (!exif) return undefined
	const start = exif.indexOf('{')
	if (start < 0) return undefined
	try {
		const json = JSON.parse(exif.subarray(start).toString('utf-8'))
		return {
			packId: json['sticker-pack-id'],
			pack: json['sticker-pack-name'],
			author: json['sticker-pack-publisher'],
			emojis: json.emojis
		}
	} catch {
		return undefined
	}
}

/* ------------------------------------------------------------------ */
/* 3. typewriter                                                       */
/* ------------------------------------------------------------------ */

/** split text into growing pieces, cut at word borders */
export const typewriterFrames = (text: string, steps = 6): string[] => {
	const value = String(text ?? '')
	const count = Math.min(15, Math.max(1, Math.floor(steps)))
	const words = value.split(/(\s+)/).filter(part => part.length)
	if (count === 1 || words.length <= 1) return [value]
	const frames: string[] = []
	const real = words.filter(word => word.trim()).length
	const per = Math.max(1, Math.ceil(real / count))
	let seen = 0
	let current = ''
	for (const word of words) {
		current += word
		if (!word.trim()) continue
		seen++
		if (seen % per === 0 && seen < real) frames.push(current.trimEnd())
	}

	frames.push(value)
	return frames.filter((frame, index) => frame && frame !== frames[index - 1])
}

/* ------------------------------------------------------------------ */
/* 4. scheduler                                                        */
/* ------------------------------------------------------------------ */

type Send = (jid: string, content: AnyMessageContent, options?: MiscMessageGenerationOptions) => Promise<any>

export type ScheduledMessage = { id: string; jid: string; at: number; content: AnyMessageContent }

export type SchedulerOptions = {
	onSent?: (job: ScheduledMessage, result: any) => void
	onError?: (error: unknown, job: ScheduledMessage) => void
	now?: () => number
}

const MAX_TIMER_MS = 2 ** 31 - 1

/** Send messages later. Lives in memory: scheduled messages are lost when the process restarts. */
export const createScheduler = (send: Send, options: SchedulerOptions = {}) => {
	const now = options.now ?? Date.now
	const jobs = new Map<string, { job: ScheduledMessage; timer: ReturnType<typeof setTimeout> }>()
	let counter = 0

	const schedule = (
		jid: string,
		content: AnyMessageContent,
		when: Date | number,
		sendOptions?: MiscMessageGenerationOptions
	): ScheduledMessage => {
		const at = when instanceof Date ? when.getTime() : now() + Number(when)
		const wait = at - now()
		if (!jid || !Number.isFinite(at)) throw new Boom('schedule needs a chat and a time', { statusCode: 400 })
		if (wait < 0) throw new Boom('that time is already over', { statusCode: 400 })
		if (wait > MAX_TIMER_MS) throw new Boom('a message can be scheduled at most 24 days ahead', { statusCode: 400 })
		const job: ScheduledMessage = { id: `sch-${++counter}-${randomBytes(3).toString('hex')}`, jid, at, content }
		const timer = setTimeout(() => {
			jobs.delete(job.id)
			send(jid, content, sendOptions).then(
				result => options.onSent?.(job, result),
				error => options.onError?.(error, job)
			)
		}, wait)
		timer.unref?.()
		jobs.set(job.id, { job, timer })
		return job
	}

	const cancel = (id: string) => {
		const hit = jobs.get(id)
		if (!hit) return false
		clearTimeout(hit.timer)
		jobs.delete(id)
		return true
	}

	return {
		schedule,
		cancel,
		list: () => [...jobs.values()].map(entry => entry.job).sort((a, b) => a.at - b.at),
		clear: () => {
			for (const id of [...jobs.keys()]) cancel(id)
		}
	}
}

/* ------------------------------------------------------------------ */
/* 9. moving a session                                                 */
/* ------------------------------------------------------------------ */

const KEY_TYPES: (keyof SignalDataTypeMap)[] = [
	'app-state-sync-version',
	'app-state-sync-key',
	'sender-key-memory',
	'sender-key',
	'identity-key',
	'device-list',
	'lid-mapping',
	'pre-key',
	'session',
	'tctoken'
]

/** read a `useMultiFileAuthState` folder into one object */
export const readMultiFileSession = async (folder: string): Promise<SessionData & { skipped: string[] }> => {
	let names: string[]
	try {
		names = await fs.readdir(folder)
	} catch {
		throw new Boom(`session folder ${folder} was not found`, { statusCode: 404 })
	}

	if (!names.includes('creds.json')) throw new Boom(`no creds.json in ${folder}`, { statusCode: 404 })
	const read = async (name: string) => JSON.parse(await fs.readFile(join(folder, name), 'utf-8'), BufferJSON.reviver)
	const creds = await read('creds.json')
	const keys: SessionData['keys'] = {}
	const skipped: string[] = []
	for (const name of names) {
		if (name === 'creds.json' || !name.endsWith('.json')) continue
		const base = name.slice(0, -5)
		const type = KEY_TYPES.find(candidate => base.startsWith(`${candidate}-`))
		if (!type) {
			skipped.push(name)
			continue
		}

		// the folder format stores "/" as "__" and ":" as "-"
		const id = base
			.slice(type.length + 1)
			.replace(/__/g, '/')
			.replace(/--/g, '::')
		try {
			;(keys[type] ||= {})[id] = await read(name)
		} catch {
			skipped.push(name)
		}
	}

	return { creds, keys, skipped }
}

export type SessionLocation = { folder: string } | { file: string } | { sessionId: string }

/**
 * Copy a login from one place to another without pairing again:
 * a session folder, a single session file, or a session string. The target
 * can also be a database store (see `useKeyValueAuthState`).
 */
export const migrateSession = async (
	from: SessionLocation,
	to: { folder: string } | { file: string } | { store: DexKeyValueStore; prefix?: string }
) => {
	let data: SessionData
	let skipped: string[] = []
	if ('folder' in from) {
		const read = await readMultiFileSession(from.folder)
		data = read
		skipped = read.skipped
	} else if ('file' in from) {
		let text: string
		try {
			text = await fs.readFile(from.file, 'utf-8')
		} catch {
			throw new Boom(`session file ${from.file} was not found`, { statusCode: 404 })
		}

		const parsed = JSON.parse(text, BufferJSON.reviver)
		if (!parsed?.creds?.noiseKey) throw new Boom('that file does not contain a login', { statusCode: 400 })
		data = { creds: parsed.creds, keys: parsed.keys || {} }
	} else {
		data = importSessionId(from.sessionId)
	}

	let count = 0
	for (const type in data.keys) count += Object.keys(data.keys[type]!).length

	if ('folder' in to) {
		const target = await useMultiFileAuthState(to.folder)
		Object.assign(target.state.creds, data.creds)
		await target.saveCreds()
		await target.state.keys.set(data.keys as any)
	} else if ('store' in to) {
		const target = await useKeyValueAuthState(to.store, { prefix: to.prefix })
		if (target.state.creds.me) {
			throw new Boom('that database already holds a login; clear it first', { statusCode: 409 })
		}

		Object.assign(target.state.creds, data.creds)
		await target.state.keys.set(data.keys as any)
		await target.saveCreds()
	} else {
		const exists = await fs.stat(to.file).then(
			() => true,
			() => false
		)
		if (exists) throw new Boom(`${to.file} already exists; delete it first`, { statusCode: 409 })
		const target = await useSingleFileAuthState(to.file)
		Object.assign(target.state.creds, data.creds)
		await target.state.keys.set(data.keys as any)
		await target.saveCreds()
		await target.flush()
	}

	return { keys: count, skipped }
}

/* ------------------------------------------------------------------ */
/* 10. connection health                                               */
/* ------------------------------------------------------------------ */

type HealthEvents = {
	on: (event: any, listener: (arg: any) => void) => void
	off: (event: any, listener: (arg: any) => void) => void
}

export type HealthReport = {
	state: 'connecting' | 'open' | 'close'
	connectedAt?: number
	uptimeMs: number
	lastMessageAt?: number
	messagesReceived: number
	disconnects: number
	lastDisconnectAt?: number
	lastDisconnectCode?: number
	/** true when connected and, if `quietMs` is set, something arrived within that time */
	healthy: boolean
}

/** Keeps a small record of the connection so a bot can answer "am I alive?" in one call */
export const createHealthMonitor = (ev: HealthEvents, options: { now?: () => number } = {}) => {
	const now = options.now ?? Date.now
	const report: Omit<HealthReport, 'uptimeMs' | 'healthy'> = { state: 'connecting', messagesReceived: 0, disconnects: 0 }

	const onConnection = (update: { connection?: string; lastDisconnect?: { error?: any } }) => {
		if (update?.connection === 'open') {
			report.state = 'open'
			report.connectedAt = now()
		} else if (update?.connection === 'close') {
			report.state = 'close'
			report.disconnects++
			report.lastDisconnectAt = now()
			const code = update.lastDisconnect?.error?.output?.statusCode
			report.lastDisconnectCode = typeof code === 'number' ? code : undefined
		} else if (update?.connection === 'connecting') {
			report.state = 'connecting'
		}
	}

	const onUpsert = ({ messages }: { messages: unknown[] }) => {
		report.lastMessageAt = now()
		report.messagesReceived += messages?.length || 0
	}

	ev.on('connection.update', onConnection)
	ev.on('messages.upsert', onUpsert)
	return {
		report: (quietMs?: number): HealthReport => {
			const open = report.state === 'open'
			const last = report.lastMessageAt ?? report.connectedAt
			return {
				...report,
				uptimeMs: open && report.connectedAt ? now() - report.connectedAt : 0,
				healthy: open && (!quietMs || (last !== undefined && now() - last <= quietMs))
			}
		},
		stop: () => {
			ev.off('connection.update', onConnection)
			ev.off('messages.upsert', onUpsert)
		}
	}
}

/* ------------------------------------------------------------------ */
/* 8. channel status                                                   */
/* ------------------------------------------------------------------ */

/** turn a channel `<status>` stanza into the `newsletter.status` event */
export const parseNewsletterStatus = (node: BinaryNode): BaileysEventMap['newsletter.status'] => {
	const count = (tag: string) => {
		const value = getBinaryNodeChild(node, tag)?.attrs?.count
		return value !== undefined && Number.isFinite(+value) ? +value : undefined
	}

	const { id, from, server_id: serverId, t, type, edit } = node.attrs
	const plaintext = getBinaryNodeChild(node, 'plaintext')
	const revoked = edit === '7' || edit === '8'
	let message: proto.IMessage | undefined
	if (!revoked && plaintext?.content instanceof Uint8Array) {
		try {
			message = proto.Message.decode(plaintext.content)
		} catch {
			message = undefined
		}
	}

	const editedAt = getBinaryNodeChild(node, 'meta')?.attrs?.msg_edit_t
	return {
		id: from!,
		messageId: id,
		server_id: serverId,
		type,
		timestamp: t ? +t : undefined,
		revoked,
		mediaType: plaintext?.attrs?.mediatype,
		message,
		reaction: type === 'reaction' ? getBinaryNodeChild(node, 'reaction')?.attrs?.code : undefined,
		viewsCount: count('views_count'),
		responsesCount: count('responses_count'),
		reactions: getBinaryNodeChildren(getBinaryNodeChild(node, 'reactions'), 'reaction').map(child => ({
			code: child.attrs.code!,
			count: +(child.attrs.count || 0)
		})),
		editedAt: editedAt ? +editedAt : undefined
	}
}
