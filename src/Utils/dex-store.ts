import { Boom } from '@hapi/boom'
import { proto } from '../../WAProto/index.js'
import type { AuthenticationCreds, AuthenticationState, SignalDataTypeMap, WAVersion } from '../Types'
import { initAuthCreds } from './auth-utils'
import { importSessionId } from './dex-bot'
import { compareVersions } from './dex-extras'
import { BufferJSON, fetchLatestWaWebVersion } from './generics'

/* ------------------------------------------------------------------ */
/* 1. session in a database (any key-value store)                      */
/* ------------------------------------------------------------------ */

/**
 * The smallest store a session needs. A Keyv instance fits as it is, and so
 * does anything else with async get / set / delete on string keys.
 */
export type DexKeyValueStore = {
	get: (key: string) => Promise<unknown> | unknown
	set: (key: string, value: string) => Promise<unknown> | unknown
	delete: (key: string) => Promise<unknown> | unknown
	/** optional: remove every key that starts with the prefix */
	clear?: (prefix: string) => Promise<unknown> | unknown
}

export type KeyValueAuthOptions = {
	/** put before every key so several bots can share one database. default 'dex:' */
	prefix?: string
	/** a SESSION_ID string, used once when the database has no login yet */
	sessionId?: string
}

const encode = (value: unknown) => JSON.stringify(value, BufferJSON.replacer)

const decode = (raw: unknown): any => {
	if (raw === undefined || raw === null) return undefined
	if (typeof raw === 'string') return JSON.parse(raw, BufferJSON.reviver)
	if (Buffer.isBuffer(raw)) return JSON.parse(raw.toString('utf-8'), BufferJSON.reviver)
	// some stores hand back an already parsed object
	return JSON.parse(JSON.stringify(raw), BufferJSON.reviver)
}

/**
 * Keeps the login in a database instead of on disk, so it survives hosts that
 * wipe their files on every restart (Railway, Render, Heroku, Koyeb).
 *
 * `store` is a Keyv instance, or the result of `mongoKeyValueStore()` /
 * `redisKeyValueStore()`, or any object with get / set / delete.
 */
export const useKeyValueAuthState = async (store: DexKeyValueStore, options: KeyValueAuthOptions = {}) => {
	if (!store || typeof store.get !== 'function' || typeof store.set !== 'function' || typeof store.delete !== 'function') {
		throw new Boom('the session store needs get, set and delete functions', { statusCode: 400 })
	}

	const prefix = options.prefix ?? 'dex:'
	const credsKey = `${prefix}creds`
	const keyName = (type: string, id: string) => `${prefix}${type}:${id}`

	let creds: AuthenticationCreds | undefined
	try {
		creds = decode(await store.get(credsKey))
	} catch {
		throw new Boom('the saved session in the database is damaged; clear it to log in again', { statusCode: 500 })
	}

	let restored = false
	const pendingKeys: { [type: string]: { [id: string]: unknown } } = {}
	if (!creds && options.sessionId) {
		const imported = importSessionId(options.sessionId)
		creds = imported.creds
		Object.assign(pendingKeys, imported.keys)
		restored = true
	}

	if (creds && !creds.noiseKey) {
		throw new Boom('the saved session in the database is not a login', { statusCode: 500 })
	}

	creds ||= initAuthCreds()

	const state: AuthenticationState = {
		creds,
		keys: {
			get: async (type, ids) => {
				const out: { [id: string]: SignalDataTypeMap[typeof type] } = {}
				await Promise.all(
					ids.map(async id => {
						let value = decode(await store.get(keyName(type, id)))
						if (type === 'app-state-sync-key' && value) {
							value = proto.Message.AppStateSyncKeyData.fromObject(value)
						}

						if (value !== undefined && value !== null) out[id] = value
					})
				)
				return out
			},
			set: async values => {
				const jobs: unknown[] = []
				for (const type in values) {
					const entries = values[type as keyof SignalDataTypeMap]!
					for (const id in entries) {
						const value = entries[id]
						jobs.push(
							value === undefined || value === null
								? store.delete(keyName(type, id))
								: store.set(keyName(type, id), encode(value))
						)
					}
				}

				await Promise.all(jobs)
			}
		}
	}

	const saveCreds = async () => {
		await store.set(credsKey, encode(state.creds))
	}

	if (restored) {
		await state.keys.set(pendingKeys as any)
		await saveCreds()
	}

	/** wipe this bot's login from the database (after a logout) */
	const clear = async () => {
		if (typeof store.clear !== 'function') {
			throw new Boom('this store cannot list its keys; delete the session rows by hand', { statusCode: 501 })
		}

		await store.clear(prefix)
	}

	return { state, saveCreds, clear }
}

/** the few collection methods used, so the `mongodb` package is not a dependency */
export type MongoCollectionLike = {
	findOne: (filter: any) => Promise<any>
	replaceOne: (filter: any, doc: any, options?: any) => Promise<any>
	deleteOne: (filter: any) => Promise<any>
	deleteMany: (filter: any) => Promise<any>
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** wraps a MongoDB collection (`db.collection('session')`) as a session store */
export const mongoKeyValueStore = (collection: MongoCollectionLike): DexKeyValueStore => {
	if (!collection || typeof collection.findOne !== 'function' || typeof collection.replaceOne !== 'function') {
		throw new Boom('pass a MongoDB collection, for example db.collection("session")', { statusCode: 400 })
	}

	return {
		get: async key => (await collection.findOne({ _id: key }))?.value,
		set: (key, value) => collection.replaceOne({ _id: key }, { _id: key, value }, { upsert: true }),
		delete: key => collection.deleteOne({ _id: key }),
		clear: prefix => collection.deleteMany({ _id: { $regex: `^${escapeRegex(prefix)}` } })
	}
}

/** the few client methods used; both `ioredis` and `redis` (node-redis) fit */
export type RedisClientLike = {
	get: (key: string) => Promise<string | null | undefined>
	set: (key: string, value: string) => Promise<unknown>
	del: (...keys: any[]) => Promise<unknown>
	keys?: (pattern: string) => Promise<string[]>
}

/** wraps a connected Redis client as a session store */
export const redisKeyValueStore = (client: RedisClientLike): DexKeyValueStore => {
	if (!client || typeof client.get !== 'function' || typeof client.set !== 'function' || typeof client.del !== 'function') {
		throw new Boom('pass a connected Redis client (ioredis or node-redis)', { statusCode: 400 })
	}

	return {
		get: key => client.get(key),
		set: (key, value) => client.set(key, value),
		delete: key => client.del(key),
		clear: async prefix => {
			if (typeof client.keys !== 'function') {
				throw new Boom('this Redis client cannot list keys', { statusCode: 501 })
			}

			const found = await client.keys(`${prefix.replace(/[*?[\]\\]/g, '\\$&')}*`)
			for (const key of found) await client.del(key)
		}
	}
}

/* ------------------------------------------------------------------ */
/* 2. speed pack                                                       */
/* ------------------------------------------------------------------ */

type VersionFetch = () => Promise<{ version?: unknown; isLatest?: boolean }>

export type ResolveWaWebVersionOptions = {
	/** version shipped with the library; an older live answer is ignored */
	bundled?: WAVersion
	/** how long one answer is reused. default 1 hour */
	ttlMs?: number
	/** give up on the request after this long. default 3000 */
	timeoutMs?: number
	fetchLatest?: VersionFetch
	now?: () => number
}

const HOUR_MS = 60 * 60 * 1000
let versionCache: { version: WAVersion | undefined; at: number } | undefined
let versionInFlight: Promise<WAVersion | undefined> | undefined

const isVersion = (v: unknown): v is WAVersion =>
	Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number' && Number.isFinite(n))

/** forget the remembered WA Web version (done automatically when WhatsApp answers 405) */
export const clearWaWebVersionCache = () => {
	versionCache = undefined
	versionInFlight = undefined
}

/**
 * Asks WhatsApp which web version it is serving right now. The answer is kept
 * for an hour and shared by every socket in the process. Returns undefined when
 * WhatsApp cannot be reached or the answer is not newer than the bundled one,
 * so the caller keeps its own version.
 */
export const resolveWaWebVersion = async (options: ResolveWaWebVersionOptions = {}): Promise<WAVersion | undefined> => {
	const now = options.now ?? Date.now
	const ttlMs = options.ttlMs ?? HOUR_MS
	if (versionCache && now() - versionCache.at < ttlMs) return versionCache.version
	if (versionInFlight) return versionInFlight

	const timeoutMs = options.timeoutMs ?? 3000
	const fetchLatest: VersionFetch =
		options.fetchLatest ?? (() => fetchLatestWaWebVersion({ signal: AbortSignal.timeout(timeoutMs) }))

	const run = (async () => {
		let version: WAVersion | undefined
		let timer: ReturnType<typeof setTimeout> | undefined
		try {
			const result = await Promise.race([
				fetchLatest(),
				new Promise<undefined>(resolve => {
					timer = setTimeout(() => resolve(undefined), timeoutMs)
					timer.unref?.()
				})
			])
			if (result && result.isLatest === true && isVersion(result.version)) {
				if (!options.bundled || compareVersions(result.version, options.bundled) > 0) {
					version = result.version
				}
			} else {
				// nothing usable: do not remember the failure, try again next connect
				return undefined
			}
		} catch {
			return undefined
		} finally {
			if (timer) clearTimeout(timer)
		}

		versionCache = { version, at: now() }
		return version
	})()

	versionInFlight = run
	try {
		return await run
	} finally {
		if (versionInFlight === run) versionInFlight = undefined
	}
}

const SIGNAL_NOISE: { [level: string]: string[] } = {
	info: ['Closing session:', 'Opening session:', 'Removing old closed session:', 'Migrating session to:'],
	warn: [
		'Closing open session in favor of incoming prekey bundle',
		'Session already closed',
		'Session already open',
		'Decrypted message with closed session.'
	]
}

let restoreConsole: (() => void) | undefined

/**
 * Hides the routine session messages the Signal library prints straight to the
 * console (they dump whole session objects on every new chat). Errors are left
 * alone. Returns a function that puts the console back.
 */
export const quietSignalLogs = () => {
	if (restoreConsole) return restoreConsole
	const original: { [level: string]: (...args: any[]) => void } = {}
	for (const level of Object.keys(SIGNAL_NOISE)) {
		const target = console as any
		const real = target[level] as (...args: any[]) => void
		original[level] = real
		const noise = SIGNAL_NOISE[level]!
		target[level] = (...args: any[]) => {
			const first = args[0]
			if (typeof first === 'string' && noise.some(text => first.startsWith(text))) return
			return real.apply(console, args)
		}
	}

	restoreConsole = () => {
		for (const level of Object.keys(original)) (console as any)[level] = original[level]
		restoreConsole = undefined
	}

	return restoreConsole
}

/** resolves with undefined when the work takes longer than `ms` */
export const withTimeLimit = async <T>(work: Promise<T>, ms: number): Promise<T | undefined> => {
	if (!(ms > 0)) return work
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			work,
			new Promise<undefined>(resolve => {
				timer = setTimeout(() => resolve(undefined), ms)
				timer.unref?.()
			})
		])
	} finally {
		if (timer) clearTimeout(timer)
	}
}
