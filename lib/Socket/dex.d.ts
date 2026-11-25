import { Boom } from '@hapi/boom';
import type { Transform } from 'stream';
import type { AnyMediaMessageContent, AnyMessageContent, MiscMessageGenerationOptions, SocketConfig, WAMediaUpload, WAMessage, WAMessageKey } from '../Types/index.js';
import { type AutoStatusOptions, type DeletedMessageEvent, type DeleteWatcherOptions, type GroupCache, type ReactionTapEvent, type ReactionTapOptions, type SendQueueOptions, type StickerWebpOptions, type TypingOptions, type ViewOnceMediaType } from '../Utils/index.js';
import { makeCommunitiesSocket } from './communities.js';
export type StickerReactionOptions = {
    /** how many sticker reactions to add (1 to 30, default 1) */
    count?: number;
    /** wait between two reactions in ms (default 0) */
    delayMs?: number;
    /** force the animated flag; by default it is read from the webp itself */
    animated?: boolean;
    /** photos, GIFs and short videos given as a Buffer are turned into a sticker first (default true) */
    convert?: boolean | StickerWebpOptions;
};
export type StickerTapOptions = ReactionTapOptions & StickerReactionOptions;
export type AlbumItem = Extract<AnyMediaMessageContent, {
    image: WAMediaUpload;
} | {
    video: WAMediaUpload;
}>;
type DexBase = Pick<ReturnType<typeof makeCommunitiesSocket>, 'sendMessage' | 'relayMessage' | 'waUploadToServer' | 'updateMediaMessage' | 'signalRepository' | 'user' | 'ev' | 'sendPresenceUpdate' | 'groupMetadata' | 'readStatus' | 'reactToStatus'>;
/** the DexBaileys helper methods, bound to a socket */
export type TagAllOptions = MiscMessageGenerationOptions & {
    /** only mention the admins */
    adminsOnly?: boolean;
    /** write the @numbers under the text (default false = hidden tag) */
    showList?: boolean;
};
export declare const makeDexHelpers: (sock: DexBase, logger: SocketConfig["logger"], sharedGroupCache?: GroupCache) => {
    /**
     * React to a message with one or more stickers / photos (the round
     * pictures WhatsApp shows around a message). Animated webp stays
     * animated; a photo, GIF or short video Buffer is converted first.
     */
    sendStickerReaction: (key: WAMessageKey, stickers: WAMediaUpload | WAMediaUpload[], options?: StickerReactionOptions) => Promise<string[]>;
    /** call `handler` when an emoji is put on a message (default: only by the linked account) */
    onReactionTap: (handler: (event: ReactionTapEvent) => unknown, options?: ReactionTapOptions) => {
        stop: () => void;
        idle: () => Promise<void>;
    };
    /**
     * Emoji shortcut: when the linked account (or whoever `allow` accepts)
     * puts an emoji on a message, that message gets the sticker reactions.
     */
    stickerReactOnTap: (stickers: WAMediaUpload | WAMediaUpload[], options?: StickerTapOptions) => {
        stop: () => void;
        idle: () => Promise<void>;
    };
    /** same person? works across phone number, bare digits and LID */
    isSameUser: (a: string | undefined | null, b: string | undefined | null) => Promise<boolean>;
    /** phone-number JID and LID of a user, as far as they are known locally */
    resolveUserJids: (jid: string) => Promise<{
        pn?: string;
        lid?: string;
    }>;
    /** send several photos / videos as one album */
    sendAlbum: (jid: string, items: AlbumItem[], options?: MiscMessageGenerationOptions & {
        delayMs?: number;
    }) => Promise<{
        album: WAMessage;
        items: WAMessage[];
    }>;
    /**
     * Download the view-once photo / video / voice note in `message`, or in
     * the message it replies to.
     */
    downloadViewOnce: <T extends "buffer" | "stream" = "buffer">(message: WAMessage, type?: T) => Promise<{
        type: ViewOnceMediaType;
        mimetype: string | undefined;
        caption: string | undefined;
        data: T extends "stream" ? Transform : Buffer;
    }>;
    /** group metadata cache, kept fresh from the socket's group events */
    groupCache: {
        get: (jid: string, force?: boolean) => Promise<import("../index.js").GroupMetadata>;
        lookup: (jid: string) => import("../index.js").GroupMetadata | undefined;
        set: (data: import("../index.js").GroupMetadata) => void;
        delete: (jid: string) => boolean;
        clear: () => void;
        size: () => number;
        bind: (ev: {
            on: (event: any, listener: (arg: any) => void) => void;
            off: (event: any, listener: (arg: any) => void) => void;
        }) => () => void;
        setFetcher: (fetch: (jid: string) => Promise<import("../index.js").GroupMetadata>) => void;
    };
    /** group metadata from the cache (asks WhatsApp only when it is missing or `fresh` is true) */
    getGroup: (jid: string, fresh?: boolean) => Promise<import("../index.js").GroupMetadata>;
    /** JIDs of the group's admins */
    groupAdmins: (jid: string) => Promise<string[]>;
    /** is `user` an admin of the group? works with a number, a JID or a LID */
    isGroupAdmin: (jid: string, user: string) => Promise<boolean>;
    /** is the linked account itself an admin of the group? */
    isBotAdmin: (jid: string) => Promise<boolean>;
    /** mention everybody (or only the admins) in a group */
    tagAll: (jid: string, text?: string, options?: TagAllOptions) => Promise<WAMessage | undefined>;
    /** text, sender, quoted, reply(), react() and download() for a received message */
    serialize: (message: WAMessage) => {
        key: import("../index.js").proto.IMessageKey & {
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
        message: import("../index.js").proto.IMessage | undefined;
        quoted: {
            key: WAMessageKey;
            id: string;
            sender: string;
            fromMe: boolean;
            type: string | undefined;
            text: string;
            isMedia: boolean;
            message: import("../index.js").proto.IMessage | undefined;
            raw: WAMessage;
            download: () => Promise<Buffer<ArrayBufferLike>>;
        } | undefined;
        raw: WAMessage;
        reply: (reply: string | AnyMessageContent, options?: MiscMessageGenerationOptions) => Promise<any>;
        send: (reply: string | AnyMessageContent, options?: MiscMessageGenerationOptions) => Promise<any>;
        react: (emoji: string) => Promise<any>;
        delete: () => Promise<any>;
        download: () => Promise<Buffer<ArrayBufferLike>>;
    };
    /** call `handler` with the original message when somebody deletes a message for everyone */
    onMessageDeleted: (handler: (event: DeletedMessageEvent) => unknown, options?: DeleteWatcherOptions) => {
        stop: () => void;
        size: () => number;
        idle: () => Promise<void>;
    };
    /** show "typing..." (or "recording...") for a moment, then send */
    sendWithTyping: (jid: string, content: AnyMessageContent, options?: MiscMessageGenerationOptions & TypingOptions) => Promise<WAMessage | undefined>;
    /** view, react to and collect incoming statuses */
    autoStatus: (options?: AutoStatusOptions) => {
        stop: () => void;
        idle: () => Promise<void>;
    };
    /** a queue that spaces out sendMessage calls, see createSendQueue */
    createSendQueue: (options?: SendQueueOptions) => {
        send: <T = WAMessage | undefined>(jid: string, content: AnyMessageContent, sendOptions?: MiscMessageGenerationOptions) => Promise<T>;
        readonly size: number;
        clear: () => void;
        idle: () => Promise<void>;
    };
};
/** DexBaileys helpers on top of the regular socket */
export declare const makeDexSocket: (config: SocketConfig) => {
    /**
     * React to a message with one or more stickers / photos (the round
     * pictures WhatsApp shows around a message). Animated webp stays
     * animated; a photo, GIF or short video Buffer is converted first.
     */
    sendStickerReaction: (key: WAMessageKey, stickers: WAMediaUpload | WAMediaUpload[], options?: StickerReactionOptions) => Promise<string[]>;
    /** call `handler` when an emoji is put on a message (default: only by the linked account) */
    onReactionTap: (handler: (event: ReactionTapEvent) => unknown, options?: ReactionTapOptions) => {
        stop: () => void;
        idle: () => Promise<void>;
    };
    /**
     * Emoji shortcut: when the linked account (or whoever `allow` accepts)
     * puts an emoji on a message, that message gets the sticker reactions.
     */
    stickerReactOnTap: (stickers: WAMediaUpload | WAMediaUpload[], options?: StickerTapOptions) => {
        stop: () => void;
        idle: () => Promise<void>;
    };
    /** same person? works across phone number, bare digits and LID */
    isSameUser: (a: string | undefined | null, b: string | undefined | null) => Promise<boolean>;
    /** phone-number JID and LID of a user, as far as they are known locally */
    resolveUserJids: (jid: string) => Promise<{
        pn?: string;
        lid?: string;
    }>;
    /** send several photos / videos as one album */
    sendAlbum: (jid: string, items: AlbumItem[], options?: MiscMessageGenerationOptions & {
        delayMs?: number;
    }) => Promise<{
        album: WAMessage;
        items: WAMessage[];
    }>;
    /**
     * Download the view-once photo / video / voice note in `message`, or in
     * the message it replies to.
     */
    downloadViewOnce: <T extends "buffer" | "stream" = "buffer">(message: WAMessage, type?: T) => Promise<{
        type: ViewOnceMediaType;
        mimetype: string | undefined;
        caption: string | undefined;
        data: T extends "stream" ? Transform : Buffer;
    }>;
    /** group metadata cache, kept fresh from the socket's group events */
    groupCache: {
        get: (jid: string, force?: boolean) => Promise<import("../index.js").GroupMetadata>;
        lookup: (jid: string) => import("../index.js").GroupMetadata | undefined;
        set: (data: import("../index.js").GroupMetadata) => void;
        delete: (jid: string) => boolean;
        clear: () => void;
        size: () => number;
        bind: (ev: {
            on: (event: any, listener: (arg: any) => void) => void;
            off: (event: any, listener: (arg: any) => void) => void;
        }) => () => void;
        setFetcher: (fetch: (jid: string) => Promise<import("../index.js").GroupMetadata>) => void;
    };
    /** group metadata from the cache (asks WhatsApp only when it is missing or `fresh` is true) */
    getGroup: (jid: string, fresh?: boolean) => Promise<import("../index.js").GroupMetadata>;
    /** JIDs of the group's admins */
    groupAdmins: (jid: string) => Promise<string[]>;
    /** is `user` an admin of the group? works with a number, a JID or a LID */
    isGroupAdmin: (jid: string, user: string) => Promise<boolean>;
    /** is the linked account itself an admin of the group? */
    isBotAdmin: (jid: string) => Promise<boolean>;
    /** mention everybody (or only the admins) in a group */
    tagAll: (jid: string, text?: string, options?: TagAllOptions) => Promise<WAMessage | undefined>;
    /** text, sender, quoted, reply(), react() and download() for a received message */
    serialize: (message: WAMessage) => {
        key: import("../index.js").proto.IMessageKey & {
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
        message: import("../index.js").proto.IMessage | undefined;
        quoted: {
            key: WAMessageKey;
            id: string;
            sender: string;
            fromMe: boolean;
            type: string | undefined;
            text: string;
            isMedia: boolean;
            message: import("../index.js").proto.IMessage | undefined;
            raw: WAMessage;
            download: () => Promise<Buffer<ArrayBufferLike>>;
        } | undefined;
        raw: WAMessage;
        reply: (reply: string | AnyMessageContent, options?: MiscMessageGenerationOptions) => Promise<any>;
        send: (reply: string | AnyMessageContent, options?: MiscMessageGenerationOptions) => Promise<any>;
        react: (emoji: string) => Promise<any>;
        delete: () => Promise<any>;
        download: () => Promise<Buffer<ArrayBufferLike>>;
    };
    /** call `handler` with the original message when somebody deletes a message for everyone */
    onMessageDeleted: (handler: (event: DeletedMessageEvent) => unknown, options?: DeleteWatcherOptions) => {
        stop: () => void;
        size: () => number;
        idle: () => Promise<void>;
    };
    /** show "typing..." (or "recording...") for a moment, then send */
    sendWithTyping: (jid: string, content: AnyMessageContent, options?: MiscMessageGenerationOptions & TypingOptions) => Promise<WAMessage | undefined>;
    /** view, react to and collect incoming statuses */
    autoStatus: (options?: AutoStatusOptions) => {
        stop: () => void;
        idle: () => Promise<void>;
    };
    /** a queue that spaces out sendMessage calls, see createSendQueue */
    createSendQueue: (options?: SendQueueOptions) => {
        send: <T = WAMessage | undefined>(jid: string, content: AnyMessageContent, sendOptions?: MiscMessageGenerationOptions) => Promise<T>;
        readonly size: number;
        clear: () => void;
        idle: () => Promise<void>;
    };
    groupParticipantsUpdate: (jid: string, participants: string[], action: import("../index.js").ParticipantAction) => Promise<{
        status: string;
        jid: string | undefined;
        content: import("../index.js").BinaryNode;
    }[]>;
    groupRequestParticipantsUpdate: (jid: string, participants: string[], action: "reject" | "approve") => Promise<{
        status: string;
        jid: string | undefined;
    }[]>;
    groupLeave: (id: string) => Promise<void>;
    communityMetadata: (jid: string) => Promise<import("../index.js").GroupMetadata>;
    communityCreate: (subject: string, body: string) => Promise<import("../index.js").GroupMetadata | null>;
    communityCreateGroup: (subject: string, participants: string[], parentCommunityJid: string) => Promise<import("../index.js").GroupMetadata | null>;
    communityLeave: (id: string) => Promise<void>;
    communityUpdateSubject: (jid: string, subject: string) => Promise<void>;
    communityLinkGroup: (groupJid: string, parentCommunityJid: string) => Promise<void>;
    communityUnlinkGroup: (groupJid: string, parentCommunityJid: string) => Promise<void>;
    communityFetchLinkedGroups: (jid: string) => Promise<{
        communityJid: string;
        isCommunity: boolean;
        linkedGroups: {
            id: string | undefined;
            subject: string;
            creation: number | undefined;
            owner: string | undefined;
            size: number | undefined;
        }[];
    }>;
    communityRequestParticipantsList: (jid: string) => Promise<{
        [key: string]: string;
    }[]>;
    communityRequestParticipantsUpdate: (jid: string, participants: string[], action: "approve" | "reject") => Promise<{
        status: string;
        jid: string | undefined;
    }[]>;
    communityParticipantsUpdate: (jid: string, participants: string[], action: import("../index.js").ParticipantAction) => Promise<{
        status: string;
        jid: string | undefined;
        content: import("../index.js").BinaryNode;
    }[]>;
    communityUpdateDescription: (jid: string, description?: string) => Promise<void>;
    communityInviteCode: (jid: string) => Promise<string | undefined>;
    communityRevokeInvite: (jid: string) => Promise<string | undefined>;
    communityAcceptInvite: (code: string) => Promise<string | undefined>;
    communityRevokeInviteV4: (communityJid: string, invitedJid: string) => Promise<boolean>;
    communityAcceptInviteV4: (key: string | WAMessageKey, inviteMessage: import("../index.js").proto.Message.IGroupInviteMessage) => Promise<any>;
    communityGetInviteInfo: (code: string) => Promise<import("../index.js").GroupMetadata>;
    communityToggleEphemeral: (jid: string, ephemeralExpiration: number) => Promise<void>;
    communitySettingUpdate: (jid: string, setting: "announcement" | "not_announcement" | "locked" | "unlocked") => Promise<void>;
    communityMemberAddMode: (jid: string, mode: "admin_add" | "all_member_add") => Promise<void>;
    communityJoinApprovalMode: (jid: string, mode: "on" | "off") => Promise<void>;
    communityFetchAllParticipating: () => Promise<{
        [_: string]: import("../index.js").GroupMetadata;
    }>;
    logger: import("../Utils/logger.js").ILogger;
    getOrderDetails: (orderId: string, tokenBase64: string) => Promise<import("../index.js").OrderDetails>;
    getCatalog: ({ jid, limit, cursor }: import("../index.js").GetCatalogOptions) => Promise<{
        products: import("../index.js").Product[];
        nextPageCursor: string | undefined;
    }>;
    getCollections: (jid?: string, limit?: number) => Promise<{
        collections: import("../index.js").CatalogCollection[];
    }>;
    productCreate: (create: import("../index.js").ProductCreate) => Promise<import("../index.js").Product>;
    productDelete: (productIds: string[]) => Promise<{
        deleted: number;
    }>;
    productUpdate: (productId: string, update: import("../index.js").ProductUpdate) => Promise<import("../index.js").Product>;
    updateBussinesProfile: (args: import("../Types/Bussines.js").UpdateBussinesProfileProps) => Promise<any>;
    updateCoverPhoto: (photo: WAMediaUpload) => Promise<number>;
    removeCoverPhoto: (id: string) => Promise<any>;
    sendMessageAck: (node: import("../index.js").BinaryNode, errorCode?: number) => Promise<void>;
    sendRetryRequest: (node: import("../index.js").BinaryNode, forceIncludeKeys?: boolean) => Promise<void>;
    rejectCall: (callId: string, callFrom: string) => Promise<void>;
    fetchMessageHistory: (count: number, oldestMsgKey: WAMessageKey, oldestMsgTimestamp: number | import("long").default) => Promise<string>;
    requestPlaceholderResend: (messageKey: WAMessageKey, msgData?: Partial<WAMessage>) => Promise<string | undefined>;
    messageRetryManager: import("../index.js").MessageRetryManager | null;
    readStatus: (statusKey: WAMessageKey, authorJid?: string) => Promise<void>;
    reactToStatus: (statusKey: WAMessageKey, emoji: string, authorJid?: string) => Promise<string>;
    sendStatus: (content: AnyMessageContent, options?: MiscMessageGenerationOptions) => Promise<WAMessage | undefined>;
    userDevicesCache: import("../index.js").PossiblyExtendedCacheStore | import("@cacheable/node-cache").NodeCache<import("../index.js").JidWithDevice[]>;
    devicesMutex: {
        mutex<T>(code: () => Promise<T> | T): Promise<T>;
    };
    issuePrivacyTokens: (jids: string[], timestamp?: number) => Promise<any>;
    assertSessions: (jids: string[], force?: boolean) => Promise<boolean>;
    relayMessage: (jid: string, message: import("../index.js").proto.IMessage, { messageId: msgId, participant, additionalAttributes, additionalNodes, useUserDevicesCache, useCachedGroupMetadata, statusJidList }: import("../index.js").MessageRelayOptions) => Promise<string>;
    sendReceipt: (jid: string, participant: string | undefined, messageIds: string[], type: import("../index.js").MessageReceiptType) => Promise<void>;
    sendReceipts: (keys: WAMessageKey[], type: import("../index.js").MessageReceiptType) => Promise<void>;
    readMessages: (keys: WAMessageKey[]) => Promise<void>;
    refreshMediaConn: (forceGet?: boolean) => Promise<import("../index.js").MediaConnInfo>;
    getMediaHost: () => string;
    waUploadToServer: import("../index.js").WAMediaUploadFunction;
    fetchPrivacySettings: (force?: boolean) => Promise<{
        [_: string]: string;
    }>;
    sendPeerDataOperationMessage: (pdoMessage: import("../index.js").proto.Message.IPeerDataOperationRequestMessage) => Promise<string>;
    createParticipantNodes: (recipientJids: string[], message: import("../index.js").proto.IMessage, extraAttrs?: import("../index.js").BinaryNode["attrs"], dsmMessage?: import("../index.js").proto.IMessage) => Promise<{
        nodes: import("../index.js").BinaryNode[];
        shouldIncludeDeviceIdentity: boolean;
    }>;
    getUSyncDevices: (jids: string[], useCache: boolean, ignoreZeroDevices: boolean) => Promise<(import("../index.js").JidWithDevice & {
        jid: string;
    })[]>;
    updateMemberLabel: (jid: string, memberLabel: string) => Promise<string>;
    updateMediaMessage: (message: WAMessage) => Promise<WAMessage>;
    sendMessage: (jid: string, content: AnyMessageContent, options?: MiscMessageGenerationOptions) => Promise<WAMessage | undefined>;
    newsletterCreate: (name: string, description?: string) => Promise<import("../index.js").NewsletterMetadata>;
    newsletterUpdate: (jid: string, updates: import("../index.js").NewsletterUpdate) => Promise<unknown>;
    newsletterSubscribers: (jid: string) => Promise<{
        subscribers: number;
    }>;
    newsletterSubscribed: () => Promise<Record<string, any>[]>;
    newsletterMetadata: (type: "invite" | "jid", key: string) => Promise<import("../index.js").NewsletterMetadata | null>;
    newsletterJidFromInvite: (inviteOrUrl: string) => Promise<string>;
    newsletterFollow: (jid: string) => Promise<unknown>;
    newsletterUnfollow: (jid: string) => Promise<unknown>;
    newsletterMute: (jid: string) => Promise<unknown>;
    newsletterUnmute: (jid: string) => Promise<unknown>;
    newsletterUpdateName: (jid: string, name: string) => Promise<unknown>;
    newsletterUpdateDescription: (jid: string, description: string) => Promise<unknown>;
    newsletterUpdatePicture: (jid: string, content: WAMediaUpload) => Promise<unknown>;
    newsletterRemovePicture: (jid: string) => Promise<unknown>;
    newsletterVotePoll: (jid: string, serverId: string, optionHashes: Uint8Array[]) => Promise<{
        ok: boolean;
        serverId: string;
        optionCount: number;
    }>;
    newsletterReactMessage: (jid: string, serverId: string, reaction?: string) => Promise<void>;
    newsletterFetchMessages: (jid: string, count: number, since: number, after: number) => Promise<any>;
    subscribeNewsletterUpdates: (jid: string) => Promise<{
        duration: string;
    } | null>;
    newsletterAdminCount: (jid: string) => Promise<number>;
    newsletterChangeOwner: (jid: string, newOwnerJid: string) => Promise<void>;
    newsletterDemote: (jid: string, userJid: string) => Promise<void>;
    newsletterDelete: (jid: string) => Promise<void>;
    groupMetadata: (jid: string) => Promise<import("../index.js").GroupMetadata>;
    groupCreate: (subject: string, participants: string[]) => Promise<import("../index.js").GroupMetadata>;
    groupUpdateSubject: (jid: string, subject: string) => Promise<void>;
    groupRequestParticipantsList: (jid: string) => Promise<{
        [key: string]: string;
    }[]>;
    groupUpdateDescription: (jid: string, description?: string) => Promise<void>;
    groupInviteCode: (jid: string) => Promise<string | undefined>;
    groupRevokeInvite: (jid: string) => Promise<string | undefined>;
    groupAcceptInvite: (code: string) => Promise<string | undefined>;
    groupRevokeInviteV4: (groupJid: string, invitedJid: string) => Promise<boolean>;
    groupAcceptInviteV4: (key: string | WAMessageKey, inviteMessage: import("../index.js").proto.Message.IGroupInviteMessage) => Promise<any>;
    groupGetInviteInfo: (code: string) => Promise<import("../index.js").GroupMetadata>;
    groupToggleEphemeral: (jid: string, ephemeralExpiration: number) => Promise<void>;
    groupSettingUpdate: (jid: string, setting: "announcement" | "not_announcement" | "locked" | "unlocked") => Promise<void>;
    groupMemberAddMode: (jid: string, mode: "admin_add" | "all_member_add") => Promise<void>;
    groupJoinApprovalMode: (jid: string, mode: "on" | "off") => Promise<void>;
    groupFetchAllParticipating: () => Promise<{
        [_: string]: import("../index.js").GroupMetadata;
    }>;
    serverProps: {
        privacyTokenOn1to1: boolean;
        profilePicPrivacyToken: boolean;
        lidTrustedTokenIssueToLid: boolean;
    };
    createCallLink: (type: "audio" | "video", event?: {
        startTime: number;
    }, timeoutMs?: number) => Promise<string | undefined>;
    getBotListV2: () => Promise<import("../index.js").BotListInfo[]>;
    messageMutex: {
        mutex<T>(code: () => Promise<T> | T): Promise<T>;
    };
    receiptMutex: {
        mutex<T>(code: () => Promise<T> | T): Promise<T>;
    };
    appStatePatchMutex: {
        mutex<T>(code: () => Promise<T> | T): Promise<T>;
    };
    notificationMutex: {
        mutex<T>(code: () => Promise<T> | T): Promise<T>;
    };
    upsertMessage: (msg: WAMessage, type: import("../index.js").MessageUpsertType) => Promise<void>;
    appPatch: (patchCreate: import("../index.js").WAPatchCreate) => Promise<void>;
    sendPresenceUpdate: (type: import("../index.js").WAPresence, toJid?: string) => Promise<void>;
    presenceSubscribe: (toJid: string) => Promise<void>;
    profilePictureUrl: (jid: string, type?: "preview" | "image", timeoutMs?: number) => Promise<string | undefined>;
    fetchBlocklist: () => Promise<(string | undefined)[]>;
    fetchStatus: (...jids: string[]) => Promise<import("../index.js").USyncQueryResultList[] | undefined>;
    fetchDisappearingDuration: (...jids: string[]) => Promise<import("../index.js").USyncQueryResultList[] | undefined>;
    updateProfilePicture: (jid: string, content: WAMediaUpload, dimensions?: {
        width: number;
        height: number;
    }) => Promise<void>;
    removeProfilePicture: (jid: string) => Promise<void>;
    updateProfileStatus: (status: string) => Promise<void>;
    updateProfileName: (name: string) => Promise<void>;
    updateBlockStatus: (jid: string, action: "block" | "unblock") => Promise<void>;
    updateDisableLinkPreviewsPrivacy: (isPreviewsDisabled: boolean) => Promise<void>;
    updateCallPrivacy: (value: import("../index.js").WAPrivacyCallValue) => Promise<void>;
    updateMessagesPrivacy: (value: import("../index.js").WAPrivacyMessagesValue) => Promise<void>;
    updateLastSeenPrivacy: (value: import("../index.js").WAPrivacyValue) => Promise<void>;
    updateOnlinePrivacy: (value: import("../index.js").WAPrivacyOnlineValue) => Promise<void>;
    updateProfilePicturePrivacy: (value: import("../index.js").WAPrivacyValue) => Promise<void>;
    updateStatusPrivacy: (value: import("../index.js").WAPrivacyValue) => Promise<void>;
    updateReadReceiptsPrivacy: (value: import("../index.js").WAReadReceiptsValue) => Promise<void>;
    updateGroupsAddPrivacy: (value: import("../index.js").WAPrivacyGroupAddValue) => Promise<void>;
    updateDefaultDisappearingMode: (duration: number) => Promise<void>;
    getBusinessProfile: (jid: string) => Promise<import("../index.js").WABusinessProfile | void>;
    resyncAppState: (collections: readonly ("critical_unblock_low" | "regular_high" | "regular_low" | "critical_block" | "regular")[], isInitialSync: boolean) => Promise<void>;
    chatModify: (mod: import("../index.js").ChatModification, jid: string) => Promise<void>;
    cleanDirtyBits: (type: "account_sync" | "groups", fromTimestamp?: number | string) => Promise<void>;
    addOrEditContact: (jid: string, contact: import("../index.js").proto.SyncActionValue.IContactAction) => Promise<void>;
    removeContact: (jid: string) => Promise<void>;
    placeholderResendCache: import("../index.js").CacheStore;
    addLabel: (jid: string, labels: import("../Types/Label.js").LabelActionBody) => Promise<void>;
    addChatLabel: (jid: string, labelId: string) => Promise<void>;
    removeChatLabel: (jid: string, labelId: string) => Promise<void>;
    addMessageLabel: (jid: string, messageId: string, labelId: string) => Promise<void>;
    removeMessageLabel: (jid: string, messageId: string, labelId: string) => Promise<void>;
    star: (jid: string, messages: {
        id: string;
        fromMe?: boolean;
    }[], star: boolean) => Promise<void>;
    addOrEditQuickReply: (quickReply: import("../Types/Bussines.js").QuickReplyAction) => Promise<void>;
    removeQuickReply: (timestamp: string) => Promise<void>;
    type: "md";
    ws: import("./Client/index.js").WebSocketClient;
    ev: import("../index.js").BaileysEventEmitter & {
        process(handler: (events: Partial<import("../index.js").BaileysEventMap>) => void | Promise<void>): () => void;
        buffer(): void;
        createBufferedFunction<A extends any[], T>(work: (...args: A) => Promise<T>): (...args: A) => Promise<T>;
        flush(): boolean;
        isBuffering(): boolean;
        destroy(): void;
    };
    authState: {
        creds: import("../index.js").AuthenticationCreds;
        keys: import("../index.js").SignalKeyStoreWithTransaction;
    };
    signalRepository: import("../index.js").SignalRepositoryWithLIDStore;
    user: import("../index.js").Contact | undefined;
    generateMessageTag: () => string;
    query: (node: import("../index.js").BinaryNode, timeoutMs?: number) => Promise<any>;
    waitForMessage: <T>(msgId: string, timeoutMs?: number | undefined) => Promise<T | undefined>;
    waitForSocketOpen: () => Promise<void>;
    sendRawMessage: (data: Uint8Array | Buffer) => Promise<void>;
    sendNode: (frame: import("../index.js").BinaryNode) => Promise<void>;
    logout: (msg?: string) => Promise<void>;
    end: (error: Error | undefined) => Promise<void>;
    registerSocketEndHandler: (handler: (error: Error | undefined) => void | Promise<void>) => void;
    onUnexpectedError: (err: Error | Boom, msg: string) => void;
    uploadPreKeys: (count?: number) => Promise<void>;
    uploadPreKeysToServerIfRequired: () => Promise<void>;
    digestKeyBundle: () => Promise<void>;
    rotateSignedPreKey: () => Promise<void>;
    requestPairingCode: (phoneNumber: string, customPairingCode?: string) => Promise<string>;
    updateServerTimeOffset: ({ attrs }: import("../index.js").BinaryNode) => void;
    sendUnifiedSession: () => Promise<void>;
    wamBuffer: import("../index.js").BinaryInfo;
    waitForConnectionUpdate: (check: (u: Partial<import("../index.js").ConnectionState>) => Promise<boolean | undefined>, timeoutMs?: number) => Promise<void>;
    sendWAMBuffer: (wamBuffer: Buffer) => Promise<any>;
    executeUSyncQuery: (usyncQuery: import("../index.js").USyncQuery) => Promise<import("../index.js").USyncQueryResult | undefined>;
    onWhatsApp: (...phoneNumber: string[]) => Promise<{
        jid: string;
        exists: boolean;
    }[] | undefined>;
    getLIDForPN: (pn: string) => Promise<string | null>;
    getPNForLID: (lid: string) => Promise<string | null>;
    fetchAccountReachoutTimelock: () => Promise<import("../index.js").ReachoutTimelockState>;
    fetchNewChatMessageCap: () => Promise<import("../index.js").NewChatMessageCapInfo>;
};
export {};
//# sourceMappingURL=dex.d.ts.map