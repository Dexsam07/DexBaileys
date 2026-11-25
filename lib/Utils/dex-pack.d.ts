import type { WAMessageContent } from '../Types/index.js';
import { type DexKeyValueStore, type KeyValueAuthOptions } from './dex-store.js';
/** CRC-32 of a buffer, as used by zip files */
export declare const crc32: (data: Uint8Array) => number;
export type ZipFile = {
    name: string;
    data: Buffer;
};
/** Pack files into one zip archive without compressing them */
export declare const createStoredZip: (files: ZipFile[]) => Buffer<ArrayBuffer>;
export declare const MAX_STICKERS_PER_PACK = 60;
export type StickerPackItem = {
    /** the sticker as webp bytes */
    data: Buffer;
    emojis?: string[];
    isAnimated?: boolean;
    /** name inside the pack; made up when left out */
    fileName?: string;
    /** text read out by screen readers */
    label?: string;
};
export type StickerPackUpload = {
    mediaKey: Uint8Array;
    fileSha256: Uint8Array;
    fileEncSha256: Uint8Array;
    fileLength: number;
    directPath: string;
};
export type StickerPackInfo = {
    name: string;
    publisher: string;
    description?: string;
    caption?: string;
    stickerPackId?: string;
};
/** Check a pack and give every sticker its file name */
export declare const planStickerPack: (info: StickerPackInfo, stickers: StickerPackItem[]) => {
    stickerPackId: string;
    files: {
        fileName: string;
        /** the sticker as webp bytes */
        data: Buffer;
        emojis?: string[];
        isAnimated?: boolean;
        /** text read out by screen readers */
        label?: string;
    }[];
};
/** The message that carries an uploaded sticker pack */
export declare const buildStickerPackMessage: (info: StickerPackInfo & {
    stickerPackId: string;
    trayIconFileName: string;
    zipLength: number;
}, files: (StickerPackItem & {
    fileName: string;
})[], pack: StickerPackUpload, icon: Pick<StickerPackUpload, "fileSha256" | "fileEncSha256" | "directPath">, messageSecret?: Uint8Array) => WAMessageContent;
/** Wrap ready message content so it shows as a status inside a group */
export declare const buildGroupStatusMessage: (inner: WAMessageContent, authorJid: string | undefined, messageSecret?: Uint8Array) => WAMessageContent;
export type SqliteStore = DexKeyValueStore & {
    close: () => void;
    count: () => number;
};
/** A key-value store kept in one SQLite file. Needs Node 22.5 or newer. */
export declare const sqliteKeyValueStore: (file: string, table?: string) => Promise<SqliteStore>;
export type SqliteAuthOptions = KeyValueAuthOptions & {
    /** an old session folder to copy in once, when the database has no login yet */
    migrateFromFolder?: string;
    table?: string;
};
/** Keep the whole login in one SQLite file. Needs Node 22.5 or newer. */
export declare const useSqliteAuthState: (file: string, options?: SqliteAuthOptions) => Promise<{
    store: SqliteStore;
    close: () => void;
    state: import("../Types/index.js").AuthenticationState;
    saveCreds: () => Promise<void>;
    clear: () => Promise<void>;
}>;
//# sourceMappingURL=dex-pack.d.ts.map