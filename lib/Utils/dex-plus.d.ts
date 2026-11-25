import type { AnyMessageContent, BaileysEventMap, MiscMessageGenerationOptions } from '../Types/index.js';
import { type BinaryNode } from '../WABinary/index.js';
import { type SessionData } from './dex-bot.js';
import { type DexKeyValueStore } from './dex-store.js';
export type StickerExifOptions = {
    /** pack name shown under the sticker */
    pack?: string;
    /** author / publisher shown under the sticker */
    author?: string;
    emojis?: string[];
    packId?: string;
};
/** the EXIF block WhatsApp reads the sticker pack name and author from */
export declare const buildStickerExif: (options: StickerExifOptions) => Buffer<ArrayBuffer>;
/** Write a pack name and author into a webp sticker (still or animated). No extra package needed. */
export declare const addStickerExif: (webp: Buffer, options: StickerExifOptions) => Buffer;
/** read the pack name and author back from a sticker */
export declare const readStickerExif: (webp: Buffer) => StickerExifOptions | undefined;
/** split text into growing pieces, cut at word borders */
export declare const typewriterFrames: (text: string, steps?: number) => string[];
type Send = (jid: string, content: AnyMessageContent, options?: MiscMessageGenerationOptions) => Promise<any>;
export type ScheduledMessage = {
    id: string;
    jid: string;
    at: number;
    content: AnyMessageContent;
};
export type SchedulerOptions = {
    onSent?: (job: ScheduledMessage, result: any) => void;
    onError?: (error: unknown, job: ScheduledMessage) => void;
    now?: () => number;
};
/** Send messages later. Lives in memory: scheduled messages are lost when the process restarts. */
export declare const createScheduler: (send: Send, options?: SchedulerOptions) => {
    schedule: (jid: string, content: AnyMessageContent, when: Date | number, sendOptions?: MiscMessageGenerationOptions) => ScheduledMessage;
    cancel: (id: string) => boolean;
    list: () => ScheduledMessage[];
    clear: () => void;
};
/** read a `useMultiFileAuthState` folder into one object */
export declare const readMultiFileSession: (folder: string) => Promise<SessionData & {
    skipped: string[];
}>;
export type SessionLocation = {
    folder: string;
} | {
    file: string;
} | {
    sessionId: string;
};
/**
 * Copy a login from one place to another without pairing again:
 * a session folder, a single session file, or a session string. The target
 * can also be a database store (see `useKeyValueAuthState`).
 */
export declare const migrateSession: (from: SessionLocation, to: {
    folder: string;
} | {
    file: string;
} | {
    store: DexKeyValueStore;
    prefix?: string;
}) => Promise<{
    keys: number;
    skipped: string[];
}>;
type HealthEvents = {
    on: (event: any, listener: (arg: any) => void) => void;
    off: (event: any, listener: (arg: any) => void) => void;
};
export type HealthReport = {
    state: 'connecting' | 'open' | 'close';
    connectedAt?: number;
    uptimeMs: number;
    lastMessageAt?: number;
    messagesReceived: number;
    disconnects: number;
    lastDisconnectAt?: number;
    lastDisconnectCode?: number;
    /** true when connected and, if `quietMs` is set, something arrived within that time */
    healthy: boolean;
};
/** Keeps a small record of the connection so a bot can answer "am I alive?" in one call */
export declare const createHealthMonitor: (ev: HealthEvents, options?: {
    now?: () => number;
}) => {
    report: (quietMs?: number) => HealthReport;
    stop: () => void;
};
/** turn a channel `<status>` stanza into the `newsletter.status` event */
export declare const parseNewsletterStatus: (node: BinaryNode) => BaileysEventMap["newsletter.status"];
export {};
//# sourceMappingURL=dex-plus.d.ts.map