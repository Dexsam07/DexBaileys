import { proto } from '../../WAProto/index.js';
import type { AnyMessageContent, AuthenticationCreds, AuthenticationState, GroupMetadata, GroupParticipant, MiscMessageGenerationOptions, WAMessage, WAMessageKey } from '../Types/index.js';
type KeyData = {
    [type: string]: {
        [id: string]: unknown;
    };
};
export type SessionData = {
    creds: AuthenticationCreds;
    keys: KeyData;
};
/**
 * Pack a session into one string (for an env var such as SESSION_ID).
 * By default only the login (creds) is packed, which is small; `full` adds
 * every key. Treat the string like a password: whoever has it owns the account.
 */
export declare const exportSessionId: (session: AuthenticationCreds | {
    creds: AuthenticationCreds;
    keys?: KeyData;
}, options?: {
    full?: boolean;
}) => string;
/** Read a string made by exportSessionId (a plain base64 creds.json is accepted too) */
export declare const importSessionId: (sessionId: string) => SessionData;
export type SingleFileAuthOptions = {
    /** used once, when the file does not exist yet (e.g. process.env.SESSION_ID) */
    sessionId?: string;
    /** changes are written together after this many ms (default 250) */
    saveDelayMs?: number;
};
/**
 * The whole session in ONE file, written atomically. Put the file on a
 * volume, or keep `exportSessionId()` in an env var and pass it as
 * `sessionId`, and a host restart no longer logs the bot out.
 */
export declare const useSingleFileAuthState: (file: string, options?: SingleFileAuthOptions) => Promise<{
    state: AuthenticationState;
    /** call on `creds.update` */
    saveCreds: () => Promise<void>;
    /** write pending changes now (call before the process exits) */
    flush: () => Promise<void>;
    /** the session as one string, see exportSessionId */
    exportSessionId: (opts?: {
        full?: boolean;
    }) => string;
}>;
type GroupEvents = {
    on: (event: any, listener: (arg: any) => void) => void;
    off: (event: any, listener: (arg: any) => void) => void;
};
export type GroupCacheOptions = {
    /** how long a group stays cached (default 5 minutes) */
    ttlMs?: number;
    /** most groups kept (default 500) */
    max?: number;
    fetch?: (jid: string) => Promise<GroupMetadata>;
    now?: () => number;
};
/**
 * Remembers group metadata and keeps it fresh from the socket's own group
 * events, so admin checks and group sends do not ask WhatsApp every time.
 */
export declare const createGroupCache: (options?: GroupCacheOptions) => {
    /** cached or freshly fetched metadata */
    get: (jid: string, force?: boolean) => Promise<GroupMetadata>;
    /** cached metadata only, never asks WhatsApp (fits `cachedGroupMetadata`) */
    lookup: (jid: string) => GroupMetadata | undefined;
    set: (data: GroupMetadata) => void;
    delete: (jid: string) => boolean;
    clear: () => void;
    size: () => number;
    bind: (ev: GroupEvents) => () => void;
    setFetcher: (fetch: (jid: string) => Promise<GroupMetadata>) => void;
};
export type GroupCache = ReturnType<typeof createGroupCache>;
/** the admins of a group (creator included) */
export declare const groupAdminsOf: (group: Pick<GroupMetadata, "participants">) => GroupParticipant[];
/** find a member by phone-number JID, LID or bare digits */
export declare const findGroupParticipant: (group: Pick<GroupMetadata, "participants">, user: string | null | undefined) => GroupParticipant | undefined;
/** the text a user typed or the id of the button / list row they tapped */
export declare const getMessageText: (message: proto.IMessage | null | undefined) => string;
type SerializeSock = {
    user?: {
        id: string;
        lid?: string;
    } | null;
    sendMessage: (jid: string, content: AnyMessageContent, options?: MiscMessageGenerationOptions) => Promise<any>;
};
export type SerializeTools = {
    download: (message: WAMessage) => Promise<Buffer>;
};
/** A message with the fields every bot needs: text, sender, quoted, reply(), react(), download() */
export declare const serializeMessage: (sock: SerializeSock, msg: WAMessage, tools: SerializeTools) => {
    key: proto.IMessageKey & {
        remoteJidAlt?: string;
        remoteJidUsername?: string;
        participantAlt?: string;
        participantUsername?: string;
        server_id?: string;
        addressingMode?: string;
        isViewOnce?: boolean;
        editActorJid?: string;
        editActorFromMe?: boolean;
        editActorPushName?: string;
    };
    id: string;
    chat: string;
    isGroup: boolean;
    fromMe: boolean;
    sender: string;
    pushName: string;
    type: string | undefined;
    text: string;
    mentions: string[];
    isMedia: boolean;
    message: proto.IMessage | undefined;
    quoted: {
        key: WAMessageKey;
        id: string;
        sender: string;
        fromMe: boolean;
        type: string | undefined;
        text: string;
        isMedia: boolean;
        message: proto.IMessage | undefined;
        raw: WAMessage;
        download: () => Promise<Buffer<ArrayBufferLike>>;
    } | undefined;
    raw: WAMessage;
    /** reply in the same chat, quoting this message */
    reply: (reply: string | AnyMessageContent, options?: MiscMessageGenerationOptions) => Promise<any>;
    /** send to the same chat without quoting */
    send: (reply: string | AnyMessageContent, options?: MiscMessageGenerationOptions) => Promise<any>;
    react: (emoji: string) => Promise<any>;
    delete: () => Promise<any>;
    download: () => Promise<Buffer<ArrayBufferLike>>;
};
export type SerializedMessage = ReturnType<typeof serializeMessage>;
type MessageEvents = {
    on: (event: any, listener: (arg: any) => void) => void;
    off: (event: any, listener: (arg: any) => void) => void;
};
export type DeletedMessageEvent = {
    /** key of the deleted message */
    key: WAMessageKey;
    chat: string;
    /** who deleted it */
    deletedBy: string;
    /** the original message, when it was seen before it got deleted */
    message?: WAMessage;
};
export type DeleteWatcherOptions = {
    /** most messages remembered (default 2000) */
    max?: number;
    /** how long a message is remembered (default 6 hours) */
    ttlMs?: number;
    /** also report messages the linked account deleted itself (default false) */
    includeFromMe?: boolean;
    onError?: (error: unknown) => void;
    now?: () => number;
};
/** Remembers recent messages and calls `handler` with the original when one is deleted for everyone */
export declare const createDeleteWatcher: (ev: MessageEvents, handler: (event: DeletedMessageEvent) => unknown, options?: DeleteWatcherOptions) => {
    stop: () => void;
    size: () => number;
    idle: () => Promise<void>;
};
export type TypingOptions = {
    /** fixed wait in ms; by default it depends on the length of the text */
    typingMs?: number;
    /** ms per character (default 40) */
    perCharMs?: number;
    /** shortest wait (default 600 ms) */
    minMs?: number;
    /** longest wait (default 5000 ms) */
    maxMs?: number;
};
/** how long a person would "type" this message */
export declare const typingDelayFor: (content: AnyMessageContent | string, options?: TypingOptions) => number;
export type StatusEvent = {
    key: WAMessageKey;
    /** who posted the status */
    author: string;
    type: string | undefined;
    text: string;
    isMedia: boolean;
    message: WAMessage;
    download: () => Promise<Buffer>;
};
export type AutoStatusOptions = {
    /** mark every status as seen (default true) */
    view?: boolean;
    /** react with this emoji, or a random one from the list */
    react?: string | string[] | false;
    /** called for every status, e.g. to save it */
    onStatus?: (status: StatusEvent) => unknown;
    /** skip statuses from these people */
    ignore?: string[];
    /** wait before viewing, in ms (default 0) */
    delayMs?: number;
    onError?: (error: unknown, status: StatusEvent) => void;
    random?: () => number;
};
type StatusSock = {
    ev: MessageEvents;
    readStatus: (key: WAMessageKey, author?: string) => Promise<unknown>;
    reactToStatus: (key: WAMessageKey, emoji: string, author?: string) => Promise<unknown>;
};
/** View, react to and collect incoming statuses with one call */
export declare const createAutoStatus: (sock: StatusSock, options: AutoStatusOptions, tools: SerializeTools) => {
    stop: () => void;
    idle: () => Promise<void>;
};
export {};
//# sourceMappingURL=dex-bot.d.ts.map