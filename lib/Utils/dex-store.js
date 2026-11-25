import { Boom } from '@hapi/boom';
import { proto } from '../../WAProto/index.js';
import { initAuthCreds } from './auth-utils.js';
import { importSessionId } from './dex-bot.js';
import { compareVersions } from './dex-extras.js';
import { BufferJSON, fetchLatestWaWebVersion } from './generics.js';
const encode = (value) => JSON.stringify(value, BufferJSON.replacer);
const decode = (raw) => {
    if (raw === undefined || raw === null)
        return undefined;
    if (typeof raw === 'string')
        return JSON.parse(raw, BufferJSON.reviver);
    if (Buffer.isBuffer(raw))
        return JSON.parse(raw.toString('utf-8'), BufferJSON.reviver);
    // some stores hand back an already parsed object
    return JSON.parse(JSON.stringify(raw), BufferJSON.reviver);
};
/**
 * Keeps the login in a database instead of on disk, so it survives hosts that
 * wipe their files on every restart (Railway, Render, Heroku, Koyeb).
 *
 * `store` is a Keyv instance, or the result of `mongoKeyValueStore()` /
 * `redisKeyValueStore()`, or any object with get / set / delete.
 */
export const useKeyValueAuthState = async (store, options = {}) => {
    if (!store || typeof store.get !== 'function' || typeof store.set !== 'function' || typeof store.delete !== 'function') {
        throw new Boom('the session store needs get, set and delete functions', { statusCode: 400 });
    }
    const prefix = options.prefix ?? 'dex:';
    const credsKey = `${prefix}creds`;
    const keyName = (type, id) => `${prefix}${type}:${id}`;
    let creds;
    try {
        creds = decode(await store.get(credsKey));
    }
    catch {
        throw new Boom('the saved session in the database is damaged; clear it to log in again', { statusCode: 500 });
    }
    let restored = false;
    const pendingKeys = {};
    if (!creds && options.sessionId) {
        const imported = importSessionId(options.sessionId);
        creds = imported.creds;
        Object.assign(pendingKeys, imported.keys);
        restored = true;
    }
    if (creds && !creds.noiseKey) {
        throw new Boom('the saved session in the database is not a login', { statusCode: 500 });
    }
    creds || (creds = initAuthCreds());
    const state = {
        creds,
        keys: {
            get: async (type, ids) => {
                const out = {};
                await Promise.all(ids.map(async (id) => {
                    let value = decode(await store.get(keyName(type, id)));
                    if (type === 'app-state-sync-key' && value) {
                        value = proto.Message.AppStateSyncKeyData.fromObject(value);
                    }
                    if (value !== undefined && value !== null)
                        out[id] = value;
                }));
                return out;
            },
            set: async (values) => {
                const jobs = [];
                for (const type in values) {
                    const entries = values[type];
                    for (const id in entries) {
                        const value = entries[id];
                        jobs.push(value === undefined || value === null
                            ? store.delete(keyName(type, id))
                            : store.set(keyName(type, id), encode(value)));
                    }
                }
                await Promise.all(jobs);
            }
        }
    };
    const saveCreds = async () => {
        await store.set(credsKey, encode(state.creds));
    };
    if (restored) {
        await state.keys.set(pendingKeys);
        await saveCreds();
    }
    /** wipe this bot's login from the database (after a logout) */
    const clear = async () => {
        if (typeof store.clear !== 'function') {
            throw new Boom('this store cannot list its keys; delete the session rows by hand', { statusCode: 501 });
        }
        await store.clear(prefix);
    };
    return { state, saveCreds, clear };
};
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** wraps a MongoDB collection (`db.collection('session')`) as a session store */
export const mongoKeyValueStore = (collection) => {
    if (!collection || typeof collection.findOne !== 'function' || typeof collection.replaceOne !== 'function') {
        throw new Boom('pass a MongoDB collection, for example db.collection("session")', { statusCode: 400 });
    }
    return {
        get: async (key) => (await collection.findOne({ _id: key }))?.value,
        set: (key, value) => collection.replaceOne({ _id: key }, { _id: key, value }, { upsert: true }),
        delete: key => collection.deleteOne({ _id: key }),
        clear: prefix => collection.deleteMany({ _id: { $regex: `^${escapeRegex(prefix)}` } })
    };
};
/** wraps a connected Redis client as a session store */
export const redisKeyValueStore = (client) => {
    if (!client || typeof client.get !== 'function' || typeof client.set !== 'function' || typeof client.del !== 'function') {
        throw new Boom('pass a connected Redis client (ioredis or node-redis)', { statusCode: 400 });
    }
    return {
        get: key => client.get(key),
        set: (key, value) => client.set(key, value),
        delete: key => client.del(key),
        clear: async (prefix) => {
            if (typeof client.keys !== 'function') {
                throw new Boom('this Redis client cannot list keys', { statusCode: 501 });
            }
            const found = await client.keys(`${prefix.replace(/[*?[\]\\]/g, '\\$&')}*`);
            for (const key of found)
                await client.del(key);
        }
    };
};
const HOUR_MS = 60 * 60 * 1000;
let versionCache;
let versionInFlight;
const isVersion = (v) => Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number' && Number.isFinite(n));
/** forget the remembered WA Web version (done automatically when WhatsApp answers 405) */
export const clearWaWebVersionCache = () => {
    versionCache = undefined;
    versionInFlight = undefined;
};
/**
 * Asks WhatsApp which web version it is serving right now. The answer is kept
 * for an hour and shared by every socket in the process. Returns undefined when
 * WhatsApp cannot be reached or the answer is not newer than the bundled one,
 * so the caller keeps its own version.
 */
export const resolveWaWebVersion = async (options = {}) => {
    const now = options.now ?? Date.now;
    const ttlMs = options.ttlMs ?? HOUR_MS;
    if (versionCache && now() - versionCache.at < ttlMs)
        return versionCache.version;
    if (versionInFlight)
        return versionInFlight;
    const timeoutMs = options.timeoutMs ?? 3000;
    const fetchLatest = options.fetchLatest ?? (() => fetchLatestWaWebVersion({ signal: AbortSignal.timeout(timeoutMs) }));
    const run = (async () => {
        let version;
        let timer;
        try {
            const result = await Promise.race([
                fetchLatest(),
                new Promise(resolve => {
                    timer = setTimeout(() => resolve(undefined), timeoutMs);
                    timer.unref?.();
                })
            ]);
            if (result && result.isLatest === true && isVersion(result.version)) {
                if (!options.bundled || compareVersions(result.version, options.bundled) > 0) {
                    version = result.version;
                }
            }
            else {
                // nothing usable: do not remember the failure, try again next connect
                return undefined;
            }
        }
        catch {
            return undefined;
        }
        finally {
            if (timer)
                clearTimeout(timer);
        }
        versionCache = { version, at: now() };
        return version;
    })();
    versionInFlight = run;
    try {
        return await run;
    }
    finally {
        if (versionInFlight === run)
            versionInFlight = undefined;
    }
};
const SIGNAL_NOISE = {
    info: ['Closing session:', 'Opening session:', 'Removing old closed session:', 'Migrating session to:'],
    warn: [
        'Closing open session in favor of incoming prekey bundle',
        'Session already closed',
        'Session already open',
        'Decrypted message with closed session.'
    ]
};
let restoreConsole;
/**
 * Hides the routine session messages the Signal library prints straight to the
 * console (they dump whole session objects on every new chat). Errors are left
 * alone. Returns a function that puts the console back.
 */
export const quietSignalLogs = () => {
    if (restoreConsole)
        return restoreConsole;
    const original = {};
    for (const level of Object.keys(SIGNAL_NOISE)) {
        const target = console;
        const real = target[level];
        original[level] = real;
        const noise = SIGNAL_NOISE[level];
        target[level] = (...args) => {
            const first = args[0];
            if (typeof first === 'string' && noise.some(text => first.startsWith(text)))
                return;
            return real.apply(console, args);
        };
    }
    restoreConsole = () => {
        for (const level of Object.keys(original))
            console[level] = original[level];
        restoreConsole = undefined;
    };
    return restoreConsole;
};
/** resolves with undefined when the work takes longer than `ms` */
export const withTimeLimit = async (work, ms) => {
    if (!(ms > 0))
        return work;
    let timer;
    try {
        return await Promise.race([
            work,
            new Promise(resolve => {
                timer = setTimeout(() => resolve(undefined), ms);
                timer.unref?.();
            })
        ]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
};
//# sourceMappingURL=dex-store.js.map