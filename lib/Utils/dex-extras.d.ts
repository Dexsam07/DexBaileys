import { proto } from '../../WAProto/index.js';
import type { AnyMessageContent, MiscMessageGenerationOptions, WAMessage, WAMessageKey, WAVersion } from '../Types/index.js';
/** WhatsApp shows at most this many sticker reactions on one message */
export declare const MAX_STICKER_REACTIONS = 30;
/** Wrap an uploaded sticker so that it is attached to `key` as a sticker reaction */
export declare const buildStickerReaction: (sticker: proto.Message.IStickerMessage, key: WAMessageKey) => proto.IMessage;
/** true when `data` is a webp file */
export declare const isWebp: (data: Uint8Array | null | undefined) => boolean;
/** true when `data` is a webp file that moves (animation flag or ANIM / ANMF chunk) */
export declare const isAnimatedWebp: (data: Uint8Array | null | undefined) => boolean;
export type StickerWebpOptions = {
    /** width and height of the sticker (default 512) */
    size?: number;
    /** only the first seconds of a video / GIF are used (default 6) */
    maxSeconds?: number;
    /** frames per second for a video (default 12) */
    fps?: number;
    /** webp quality 1 to 100 (default 60) */
    quality?: number;
    /** the result is squeezed until it is below this size (default 900 KB) */
    maxBytes?: number;
    /** ffmpeg binary (default "ffmpeg") */
    ffmpegPath?: string;
};
/**
 * Turn a photo, GIF, animated webp or short video into a sticker webp.
 * Moving input stays moving. Photos / GIFs need the optional `sharp` package,
 * videos need `ffmpeg` on the host.
 */
export declare const makeStickerWebp: (input: Buffer, options?: StickerWebpOptions) => Promise<{
    data: Buffer;
    isAnimated: boolean;
}>;
export type ReactionTapEvent = {
    /** the message that got the emoji */
    key: WAMessageKey;
    /** the emoji */
    emoji: string;
    /** who reacted */
    reactor: string;
    /** true when the linked account itself reacted */
    fromMe: boolean;
};
export type ReactionTapOptions = {
    /** only these emoji trigger the handler (default: any emoji) */
    emoji?: string | string[];
    /** who may trigger it (default: only the linked account itself) */
    allow?: (event: ReactionTapEvent) => boolean | Promise<boolean>;
    /** ignore taps that follow the last accepted one faster than this (default 3000 ms) */
    cooldownMs?: number;
    /** ignore reactions older than this, e.g. after a reconnect (default 60000 ms) */
    maxAgeMs?: number;
    onError?: (error: unknown, event: ReactionTapEvent) => void;
    /** for tests */
    now?: () => number;
};
type ReactionEmitter = {
    on: (event: 'messages.reaction', listener: (items: {
        key: WAMessageKey;
        reaction: proto.IReaction;
    }[]) => void) => void;
    off: (event: 'messages.reaction', listener: (items: {
        key: WAMessageKey;
        reaction: proto.IReaction;
    }[]) => void) => void;
};
/**
 * Calls `handler` when somebody puts an emoji on a message, so "tap an emoji"
 * can be used as a shortcut for a command. Removed reactions are ignored.
 */
export declare const createReactionTap: (ev: ReactionEmitter, handler: (event: ReactionTapEvent) => unknown, options?: ReactionTapOptions) => {
    stop: () => void;
    /** resolves when every tap received so far has been handled */
    idle: () => Promise<void>;
};
export type JidLookup = {
    getLIDForPN: (pn: string) => Promise<string | null>;
    getPNForLID: (lid: string) => Promise<string | null>;
};
/** Phone-number JID and LID of one user, as far as the local mapping knows them */
export declare const resolveUserJids: (jid: string, lookup: JidLookup) => Promise<{
    pn?: string;
    lid?: string;
}>;
/**
 * true when both values are the same WhatsApp user, also when one is a phone
 * number (or bare digits) and the other one is that user's LID.
 */
export declare const isSameUser: (a: string | undefined | null, b: string | undefined | null, lookup: JidLookup) => Promise<boolean>;
export type ViewOnceMediaType = 'image' | 'video' | 'audio';
export type ViewOnceContent = {
    type: ViewOnceMediaType;
    /** bare media message, ready for downloadMediaMessage */
    message: proto.IMessage;
    mimetype?: string;
    caption?: string;
};
/**
 * Find the view-once media in a message, or in the message it quotes.
 * Returns undefined when there is none.
 */
export declare const extractViewOnceContent: (message: proto.IMessage | null | undefined) => ViewOnceContent | undefined;
/** throws a clear error when a view-once can no longer be downloaded */
export declare const assertViewOnceDownloadable: (content: ViewOnceContent) => void;
export declare const compareVersions: (a: readonly number[], b: readonly number[]) => number;
/** newest of the given versions; invalid entries are ignored */
export declare const pickNewestVersion: (...versions: unknown[]) => WAVersion | undefined;
export type VersionStoreOptions = {
    /** JSON file that remembers the newest version seen */
    file: string;
    /** version shipped with the library, used as the floor */
    bundled?: WAVersion;
    /** resolves the latest version; only trusted when `isLatest` is true */
    fetchLatest?: () => Promise<{
        version: WAVersion;
        isLatest?: boolean;
    }>;
};
/**
 * Remembers the newest WhatsApp Web version on disk, so a restart or a failed
 * version fetch never falls back to an older revision (which makes WhatsApp
 * close the connection with 408 again and again).
 */
export declare const createVersionStore: ({ file, bundled, fetchLatest }: VersionStoreOptions) => {
    get: () => Promise<WAVersion | undefined>;
    resolve: () => Promise<WAVersion | undefined>;
};
export type SendQueueOptions = {
    /** minimum gap between any two sends (default 1000ms) */
    minDelayMs?: number;
    /** minimum gap between two sends to the same chat (default 1500ms) */
    perChatDelayMs?: number;
    /** random extra wait added to every gap (default 500ms) */
    jitterMs?: number;
    /** hard cap of sends per rolling minute (default 20) */
    maxPerMinute?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
};
type Sender = {
    sendMessage: (jid: string, content: AnyMessageContent, options?: MiscMessageGenerationOptions) => Promise<any>;
};
/**
 * Sends messages one after another with a gap, so a broadcast style command
 * does not fire dozens of messages in the same second.
 */
export declare const createSendQueue: (sock: Sender, options?: SendQueueOptions) => {
    send: <T = WAMessage | undefined>(jid: string, content: AnyMessageContent, sendOptions?: MiscMessageGenerationOptions) => Promise<T>;
    /** number of messages waiting or being sent */
    readonly size: number;
    /** drop everything that has not been sent yet */
    clear: () => void;
    /** resolves when the queue is empty */
    idle: () => Promise<void>;
};
export {};
//# sourceMappingURL=dex-extras.d.ts.map