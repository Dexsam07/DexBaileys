import type { AuthenticationState, WAVersion } from '../Types/index.js';
/**
 * The smallest store a session needs. A Keyv instance fits as it is, and so
 * does anything else with async get / set / delete on string keys.
 */
export type DexKeyValueStore = {
    get: (key: string) => Promise<unknown> | unknown;
    set: (key: string, value: string) => Promise<unknown> | unknown;
    delete: (key: string) => Promise<unknown> | unknown;
    /** optional: remove every key that starts with the prefix */
    clear?: (prefix: string) => Promise<unknown> | unknown;
};
export type KeyValueAuthOptions = {
    /** put before every key so several bots can share one database. default 'dex:' */
    prefix?: string;
    /** a SESSION_ID string, used once when the database has no login yet */
    sessionId?: string;
};
/**
 * Keeps the login in a database instead of on disk, so it survives hosts that
 * wipe their files on every restart (Railway, Render, Heroku, Koyeb).
 *
 * `store` is a Keyv instance, or the result of `mongoKeyValueStore()` /
 * `redisKeyValueStore()`, or any object with get / set / delete.
 */
export declare const useKeyValueAuthState: (store: DexKeyValueStore, options?: KeyValueAuthOptions) => Promise<{
    state: AuthenticationState;
    saveCreds: () => Promise<void>;
    clear: () => Promise<void>;
}>;
/** the few collection methods used, so the `mongodb` package is not a dependency */
export type MongoCollectionLike = {
    findOne: (filter: any) => Promise<any>;
    replaceOne: (filter: any, doc: any, options?: any) => Promise<any>;
    deleteOne: (filter: any) => Promise<any>;
    deleteMany: (filter: any) => Promise<any>;
};
/** wraps a MongoDB collection (`db.collection('session')`) as a session store */
export declare const mongoKeyValueStore: (collection: MongoCollectionLike) => DexKeyValueStore;
/** the few client methods used; both `ioredis` and `redis` (node-redis) fit */
export type RedisClientLike = {
    get: (key: string) => Promise<string | null | undefined>;
    set: (key: string, value: string) => Promise<unknown>;
    del: (...keys: any[]) => Promise<unknown>;
    keys?: (pattern: string) => Promise<string[]>;
};
/** wraps a connected Redis client as a session store */
export declare const redisKeyValueStore: (client: RedisClientLike) => DexKeyValueStore;
type VersionFetch = () => Promise<{
    version?: unknown;
    isLatest?: boolean;
}>;
export type ResolveWaWebVersionOptions = {
    /** version shipped with the library; an older live answer is ignored */
    bundled?: WAVersion;
    /** how long one answer is reused. default 1 hour */
    ttlMs?: number;
    /** give up on the request after this long. default 3000 */
    timeoutMs?: number;
    fetchLatest?: VersionFetch;
    now?: () => number;
};
/** forget the remembered WA Web version (done automatically when WhatsApp answers 405) */
export declare const clearWaWebVersionCache: () => void;
/**
 * Asks WhatsApp which web version it is serving right now. The answer is kept
 * for an hour and shared by every socket in the process. Returns undefined when
 * WhatsApp cannot be reached or the answer is not newer than the bundled one,
 * so the caller keeps its own version.
 */
export declare const resolveWaWebVersion: (options?: ResolveWaWebVersionOptions) => Promise<WAVersion | undefined>;
/**
 * Hides the routine session messages the Signal library prints straight to the
 * console (they dump whole session objects on every new chat). Errors are left
 * alone. Returns a function that puts the console back.
 */
export declare const quietSignalLogs: () => () => void;
/** resolves with undefined when the work takes longer than `ms` */
export declare const withTimeLimit: <T>(work: Promise<T>, ms: number) => Promise<T | undefined>;
export {};
//# sourceMappingURL=dex-store.d.ts.map