import { Boom } from '@hapi/boom';
import { promises as fs } from 'fs';
import { dirname } from 'path';
import { gunzipSync, gzipSync } from 'zlib';
import { proto } from '../../WAProto/index.js';
import { WAMessageStubType } from '../Types/index.js';
import { areJidsSameUser, isJidGroup, jidNormalizedUser } from '../WABinary/index.js';
import { initAuthCreds } from './auth-utils.js';
import { BufferJSON } from './generics.js';
import { getContentType, normalizeMessageContent } from './messages.js';
const SESSION_PREFIX = 'DEX~';
/**
 * Pack a session into one string (for an env var such as SESSION_ID).
 * By default only the login (creds) is packed, which is small; `full` adds
 * every key. Treat the string like a password: whoever has it owns the account.
 */
export const exportSessionId = (session, options = {}) => {
    const creds = 'creds' in session ? session.creds : session;
    if (!creds?.noiseKey)
        throw new Boom('exportSessionId needs the session creds', { statusCode: 400 });
    const keys = options.full && 'creds' in session && session.keys ? session.keys : {};
    const json = JSON.stringify({ v: 1, creds, keys }, BufferJSON.replacer);
    return SESSION_PREFIX + gzipSync(Buffer.from(json)).toString('base64');
};
/** Read a string made by exportSessionId (a plain base64 creds.json is accepted too) */
export const importSessionId = (sessionId) => {
    const text = String(sessionId || '').trim();
    const payload = text.slice(text.lastIndexOf('~') + 1);
    if (!payload)
        throw new Boom('the session id is empty', { statusCode: 400 });
    let parsed;
    try {
        let raw = Buffer.from(payload, 'base64');
        if (raw[0] === 0x1f && raw[1] === 0x8b)
            raw = gunzipSync(raw);
        parsed = JSON.parse(raw.toString('utf-8'), BufferJSON.reviver);
    }
    catch {
        throw new Boom('the session id is damaged or incomplete', { statusCode: 400 });
    }
    const creds = parsed?.creds ?? parsed;
    if (!creds?.noiseKey || !creds?.signedIdentityKey) {
        throw new Boom('the session id does not contain a login', { statusCode: 400 });
    }
    return { creds, keys: parsed?.creds && parsed.keys && typeof parsed.keys === 'object' ? parsed.keys : {} };
};
/**
 * The whole session in ONE file, written atomically. Put the file on a
 * volume, or keep `exportSessionId()` in an env var and pass it as
 * `sessionId`, and a host restart no longer logs the bot out.
 */
export const useSingleFileAuthState = async (file, options = {}) => {
    const saveDelayMs = options.saveDelayMs ?? 250;
    let data;
    let existing;
    try {
        existing = await fs.readFile(file, 'utf-8');
    }
    catch { }
    if (existing !== undefined) {
        try {
            const parsed = JSON.parse(existing, BufferJSON.reviver);
            if (!parsed?.creds?.noiseKey)
                throw new Error('no creds');
            data = { creds: parsed.creds, keys: parsed.keys || {} };
        }
        catch {
            throw new Boom(`the session file ${file} is damaged; delete it to log in again`, { statusCode: 500 });
        }
    }
    else if (options.sessionId) {
        data = importSessionId(options.sessionId);
    }
    const session = data ?? { creds: initAuthCreds(), keys: {} };
    let timer;
    let dirty = existing === undefined && !!data;
    let chain = Promise.resolve();
    const write = async () => {
        if (!dirty)
            return;
        dirty = false;
        const tmp = `${file}.tmp`;
        await fs.mkdir(dirname(file), { recursive: true });
        await fs.writeFile(tmp, JSON.stringify(session, BufferJSON.replacer));
        await fs.rename(tmp, file);
    };
    const flush = () => {
        if (timer)
            clearTimeout(timer);
        timer = undefined;
        chain = chain.then(write, write);
        return chain;
    };
    const schedule = () => {
        dirty = true;
        if (timer)
            return;
        timer = setTimeout(() => {
            timer = undefined;
            flush().catch(() => { });
        }, saveDelayMs);
        timer.unref?.();
    };
    if (dirty)
        await flush();
    const state = {
        creds: session.creds,
        keys: {
            get: async (type, ids) => {
                const out = {};
                const bucket = session.keys[type] || {};
                for (const id of ids) {
                    let value = bucket[id];
                    if (type === 'app-state-sync-key' && value) {
                        value = proto.Message.AppStateSyncKeyData.fromObject(value);
                    }
                    if (value !== undefined && value !== null)
                        out[id] = value;
                }
                return out;
            },
            set: async (values) => {
                var _a;
                for (const type in values) {
                    const bucket = ((_a = session.keys)[type] || (_a[type] = {}));
                    const entries = values[type];
                    for (const id in entries) {
                        const value = entries[id];
                        if (value)
                            bucket[id] = value;
                        else
                            delete bucket[id];
                    }
                }
                schedule();
            },
            clear: async () => {
                session.keys = {};
                schedule();
            }
        }
    };
    return {
        state,
        /** call on `creds.update` */
        saveCreds: async () => schedule(),
        /** write pending changes now (call before the process exits) */
        flush,
        /** the session as one string, see exportSessionId */
        exportSessionId: (opts) => exportSessionId(session, opts)
    };
};
const sameParticipant = (a, b) => a.id === b.id ||
    (!!a.lid && (a.lid === b.lid || a.lid === b.id)) ||
    (!!b.lid && b.lid === a.id) ||
    (!!a.phoneNumber && (a.phoneNumber === b.phoneNumber || a.phoneNumber === b.id)) ||
    (!!b.phoneNumber && b.phoneNumber === a.id);
/**
 * Remembers group metadata and keeps it fresh from the socket's own group
 * events, so admin checks and group sends do not ask WhatsApp every time.
 */
export const createGroupCache = (options = {}) => {
    const ttlMs = options.ttlMs ?? 5 * 60 * 1000;
    const max = options.max ?? 500;
    const now = options.now ?? Date.now;
    let fetcher = options.fetch;
    const store = new Map();
    const pending = new Map();
    const set = (data) => {
        if (!data?.id || !Array.isArray(data.participants))
            return;
        store.delete(data.id);
        store.set(data.id, { at: now(), data });
        while (store.size > max)
            store.delete(store.keys().next().value);
    };
    const lookup = (jid) => {
        const hit = store.get(jid);
        if (!hit)
            return undefined;
        if (now() - hit.at > ttlMs) {
            store.delete(jid);
            return undefined;
        }
        return hit.data;
    };
    const get = async (jid, force = false) => {
        const cached = force ? undefined : lookup(jid);
        if (cached)
            return cached;
        if (!fetcher)
            throw new Boom('the group cache has no way to fetch a group', { statusCode: 500 });
        let job = pending.get(jid);
        if (!job) {
            job = fetcher(jid)
                .then(data => {
                set(data);
                return data;
            })
                .finally(() => pending.delete(jid));
            pending.set(jid, job);
        }
        return job;
    };
    const applyParticipants = (id, participants, action) => {
        const hit = store.get(id);
        if (!hit)
            return;
        const data = hit.data;
        if (action === 'add') {
            for (const p of participants) {
                if (!data.participants.some(x => sameParticipant(x, p)))
                    data.participants.push({ ...p, admin: p.admin ?? null });
            }
        }
        else if (action === 'remove') {
            data.participants = data.participants.filter(x => !participants.some(p => sameParticipant(x, p)));
        }
        else if (action === 'promote' || action === 'demote') {
            for (const x of data.participants) {
                if (!participants.some(p => sameParticipant(x, p)))
                    continue;
                x.admin = action === 'promote' ? (x.admin === 'superadmin' ? 'superadmin' : 'admin') : null;
                x.isAdmin = action === 'promote';
                if (action === 'demote')
                    x.isSuperAdmin = false;
            }
        }
        else {
            store.delete(id);
            return;
        }
        data.size = data.participants.length;
    };
    const bind = (ev) => {
        const onUpsert = (groups) => {
            for (const group of groups || [])
                set(group);
        };
        const onUpdate = (updates) => {
            for (const update of updates || []) {
                const hit = update?.id ? store.get(update.id) : undefined;
                if (hit)
                    Object.assign(hit.data, update);
            }
        };
        const onParticipants = (event) => {
            if (event?.id && Array.isArray(event.participants))
                applyParticipants(event.id, event.participants, event.action);
        };
        ev.on('groups.upsert', onUpsert);
        ev.on('groups.update', onUpdate);
        ev.on('group-participants.update', onParticipants);
        return () => {
            ev.off('groups.upsert', onUpsert);
            ev.off('groups.update', onUpdate);
            ev.off('group-participants.update', onParticipants);
        };
    };
    return {
        /** cached or freshly fetched metadata */
        get,
        /** cached metadata only, never asks WhatsApp (fits `cachedGroupMetadata`) */
        lookup,
        set,
        delete: (jid) => store.delete(jid),
        clear: () => store.clear(),
        size: () => store.size,
        bind,
        setFetcher: (fetch) => {
            fetcher = fetch;
        }
    };
};
/** the admins of a group (creator included) */
export const groupAdminsOf = (group) => (group.participants || []).filter(p => p.admin === 'admin' || p.admin === 'superadmin' || p.isAdmin || p.isSuperAdmin);
/** find a member by phone-number JID, LID or bare digits */
export const findGroupParticipant = (group, user) => {
    if (!user)
        return undefined;
    const raw = String(user).trim();
    const wanted = raw.includes('@') ? jidNormalizedUser(raw) : `${raw.replace(/\D/g, '')}@s.whatsapp.net`;
    return (group.participants || []).find(p => [p.id, p.lid, p.phoneNumber].some(candidate => !!candidate && areJidsSameUser(candidate, wanted)));
};
/* ------------------------------------------------------------------ */
/* 3. message helper                                                   */
/* ------------------------------------------------------------------ */
const MEDIA_TYPES = new Set(['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage', 'ptvMessage']);
/** the text a user typed or the id of the button / list row they tapped */
export const getMessageText = (message) => {
    const content = normalizeMessageContent(message);
    if (!content)
        return '';
    const flow = content.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson;
    if (flow) {
        try {
            const id = JSON.parse(flow)?.id;
            if (typeof id === 'string' && id)
                return id;
        }
        catch { }
    }
    return (content.conversation ||
        content.extendedTextMessage?.text ||
        content.imageMessage?.caption ||
        content.videoMessage?.caption ||
        content.documentMessage?.caption ||
        content.buttonsResponseMessage?.selectedButtonId ||
        content.listResponseMessage?.singleSelectReply?.selectedRowId ||
        content.templateButtonReplyMessage?.selectedId ||
        content.interactiveResponseMessage?.body?.text ||
        '');
};
const contextInfoOf = (content, type) => (type && content?.[type]?.contextInfo) || undefined;
/** A message with the fields every bot needs: text, sender, quoted, reply(), react(), download() */
export const serializeMessage = (sock, msg, tools) => {
    const chat = msg.key.remoteJid || '';
    const me = sock.user?.id ? jidNormalizedUser(sock.user.id) : '';
    const meLid = sock.user?.lid ? jidNormalizedUser(sock.user.lid) : '';
    const isMe = (jid) => !!jid && (areJidsSameUser(jid, me) || (!!meLid && areJidsSameUser(jid, meLid)));
    const isGroup = !!isJidGroup(chat);
    const fromMe = !!msg.key.fromMe;
    const sender = jidNormalizedUser(fromMe ? me || chat : msg.key.participant || chat);
    const content = normalizeMessageContent(msg.message);
    const type = getContentType(content);
    const context = contextInfoOf(content, type);
    let quoted;
    if (context?.quotedMessage && context.stanzaId) {
        const quotedSender = jidNormalizedUser(context.participant || chat);
        const quotedContent = normalizeMessageContent(context.quotedMessage);
        const quotedType = getContentType(quotedContent);
        const key = {
            remoteJid: chat,
            id: context.stanzaId,
            fromMe: isMe(quotedSender),
            ...(isGroup ? { participant: quotedSender } : {})
        };
        const quotedMessage = { key, message: context.quotedMessage };
        quoted = {
            key,
            id: context.stanzaId,
            sender: quotedSender,
            fromMe: !!key.fromMe,
            type: quotedType,
            text: getMessageText(context.quotedMessage),
            isMedia: !!quotedType && MEDIA_TYPES.has(quotedType),
            message: quotedContent,
            raw: quotedMessage,
            download: () => tools.download(quotedMessage)
        };
    }
    return {
        key: msg.key,
        id: msg.key.id || '',
        chat,
        isGroup,
        fromMe,
        sender,
        pushName: msg.pushName || '',
        type,
        text: getMessageText(msg.message),
        mentions: (context?.mentionedJid || []),
        isMedia: !!type && MEDIA_TYPES.has(type),
        message: content,
        quoted,
        raw: msg,
        /** reply in the same chat, quoting this message */
        reply: (reply, options = {}) => sock.sendMessage(chat, typeof reply === 'string' ? { text: reply } : reply, { quoted: msg, ...options }),
        /** send to the same chat without quoting */
        send: (reply, options = {}) => sock.sendMessage(chat, typeof reply === 'string' ? { text: reply } : reply, options),
        react: (emoji) => sock.sendMessage(chat, { react: { text: emoji, key: msg.key } }),
        delete: () => sock.sendMessage(chat, { delete: msg.key }),
        download: () => tools.download(msg)
    };
};
/** Remembers recent messages and calls `handler` with the original when one is deleted for everyone */
export const createDeleteWatcher = (ev, handler, options = {}) => {
    const max = options.max ?? 2000;
    const ttlMs = options.ttlMs ?? 6 * 60 * 60 * 1000;
    const now = options.now ?? Date.now;
    const seen = new Map();
    let chain = Promise.resolve();
    const idOf = (key) => `${key.remoteJid}|${key.id}`;
    const onUpsert = ({ messages }) => {
        for (const message of messages || []) {
            const key = message?.key;
            if (!key?.remoteJid || !key.id || !message.message)
                continue;
            if (message.message.protocolMessage || message.message.reactionMessage)
                continue;
            seen.set(idOf(key), { at: now(), message });
            while (seen.size > max)
                seen.delete(seen.keys().next().value);
        }
    };
    const onUpdate = (updates) => {
        for (const item of updates || []) {
            const revoked = item?.update?.messageStubType === WAMessageStubType.REVOKE && item.update.message === null;
            if (!revoked || !item.key?.remoteJid || !item.key.id)
                continue;
            const actor = item.update.key;
            if (actor?.fromMe && !options.includeFromMe)
                continue;
            const hit = seen.get(idOf(item.key));
            seen.delete(idOf(item.key));
            const message = hit && now() - hit.at <= ttlMs ? hit.message : undefined;
            const event = {
                key: message?.key ?? item.key,
                chat: item.key.remoteJid,
                deletedBy: jidNormalizedUser(actor?.participant || actor?.remoteJid || item.key.remoteJid),
                ...(message ? { message } : {})
            };
            chain = chain.then(async () => {
                try {
                    await handler(event);
                }
                catch (error) {
                    options.onError?.(error);
                }
            });
        }
    };
    ev.on('messages.upsert', onUpsert);
    ev.on('messages.update', onUpdate);
    return {
        stop: () => {
            ev.off('messages.upsert', onUpsert);
            ev.off('messages.update', onUpdate);
            seen.clear();
        },
        size: () => seen.size,
        idle: () => chain
    };
};
/** how long a person would "type" this message */
export const typingDelayFor = (content, options = {}) => {
    if (typeof options.typingMs === 'number')
        return Math.max(0, options.typingMs);
    const minMs = options.minMs ?? 600;
    const maxMs = options.maxMs ?? 5000;
    const anyContent = content;
    const text = typeof content === 'string' ? content : anyContent?.text || anyContent?.caption || '';
    const estimate = text ? String(text).length * (options.perCharMs ?? 40) : 1200;
    return Math.min(maxMs, Math.max(minMs, estimate));
};
/** View, react to and collect incoming statuses with one call */
export const createAutoStatus = (sock, options, tools) => {
    const view = options.view ?? true;
    const emojis = options.react ? [].concat(options.react).filter(Boolean) : [];
    const ignore = (options.ignore || []).map(jid => jidNormalizedUser(jid.includes('@') ? jid : `${jid.replace(/\D/g, '')}@s.whatsapp.net`));
    const random = options.random ?? Math.random;
    let chain = Promise.resolve();
    let stopped = false;
    const handle = async (message) => {
        const key = message.key;
        const author = jidNormalizedUser(key.participant || key.participantAlt || '');
        if (!author || !key.id)
            return;
        if (ignore.some(jid => areJidsSameUser(jid, author) || areJidsSameUser(jid, key.participantAlt || '')))
            return;
        const content = normalizeMessageContent(message.message);
        const type = getContentType(content);
        const status = {
            key,
            author,
            type,
            text: getMessageText(message.message),
            isMedia: !!type && MEDIA_TYPES.has(type),
            message,
            download: () => tools.download(message)
        };
        try {
            if (options.delayMs)
                await new Promise(resolve => setTimeout(resolve, options.delayMs));
            if (stopped)
                return;
            if (view)
                await sock.readStatus(key, author);
            if (emojis.length)
                await sock.reactToStatus(key, emojis[Math.floor(random() * emojis.length)], author);
            await options.onStatus?.(status);
        }
        catch (error) {
            options.onError?.(error, status);
        }
    };
    const onUpsert = ({ messages }) => {
        for (const message of messages || []) {
            if (message?.key?.remoteJid !== 'status@broadcast' || message.key.fromMe || !message.message)
                continue;
            if (message.message.protocolMessage || message.message.reactionMessage)
                continue;
            if (message.message.senderKeyDistributionMessage && Object.keys(message.message).length === 1)
                continue;
            chain = chain.then(() => handle(message));
        }
    };
    sock.ev.on('messages.upsert', onUpsert);
    return {
        stop: () => {
            stopped = true;
            sock.ev.off('messages.upsert', onUpsert);
        },
        idle: () => chain
    };
};
//# sourceMappingURL=dex-bot.js.map