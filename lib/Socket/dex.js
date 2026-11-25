import { Boom } from '@hapi/boom';
import { promises as fs } from 'fs';
import { DEFAULT_CONNECTION_CONFIG } from '../Defaults/index.js';
import { addStickerExif, assertViewOnceDownloadable, buildStickerReaction, createAutoStatus, createDeleteWatcher, createGroupCache, createHealthMonitor, createReactionTap, createScheduler, createSendQueue, delay, downloadMediaMessage, extractViewOnceContent, buildGroupStatusMessage, buildStickerPackMessage, createStoredZip, encryptedStream, findGroupParticipant, generateWAMessageContent, generateWAMessageFromContent, planStickerPack, quietSignalLogs, generateMessageIDV2, groupAdminsOf, isAnimatedWebp, isSameUser, isWebp, makeStickerWebp, MAX_STICKER_REACTIONS, prepareWAMessageMedia, resolveUserJids, serializeMessage, typewriterFrames, typingDelayFor } from '../Utils/index.js';
import { isLidUser, isPnUser, jidNormalizedUser } from '../WABinary/index.js';
import { USyncQuery, USyncUser } from '../WAUSync/index.js';
import { makeCommunitiesSocket } from './communities.js';
export const makeDexHelpers = (sock, logger, sharedGroupCache) => {
    const groupCache = sharedGroupCache ?? createGroupCache();
    groupCache.setFetcher(jid => sock.groupMetadata(jid));
    if (!sharedGroupCache && sock.ev)
        groupCache.bind(sock.ev);
    const download = (message) => downloadMediaMessage(message, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
    const userMatches = async (participant, user) => {
        for (const candidate of [participant.id, participant.lid, participant.phoneNumber]) {
            if (candidate && (await isSameUser(candidate, user, lookup)))
                return true;
        }
        return false;
    };
    const lookup = {
        getLIDForPN: (pn) => sock.signalRepository.lidMapping.getLIDForPN(pn),
        getPNForLID: (lid) => sock.signalRepository.lidMapping.getPNForLID(lid)
    };
    // an uploaded sticker is reused for 6 hours, so repeated reactions do not upload again
    const UPLOAD_TTL_MS = 6 * 60 * 60 * 1000;
    const uploads = new WeakMap();
    const uploadSticker = async (sticker, options) => {
        const cacheKey = typeof sticker === 'object' && sticker ? sticker : undefined;
        const cached = cacheKey && uploads.get(cacheKey);
        if (cached && Date.now() - cached.at < UPLOAD_TTL_MS)
            return cached.sticker;
        let media = sticker;
        let animated = options.animated;
        if (Buffer.isBuffer(sticker)) {
            if (!isWebp(sticker) && options.convert !== false) {
                const made = await makeStickerWebp(sticker, typeof options.convert === 'object' ? options.convert : {});
                media = made.data;
                animated ?? (animated = made.isAnimated);
            }
            else {
                animated ?? (animated = isAnimatedWebp(sticker));
            }
        }
        const prepared = await prepareWAMessageMedia({ sticker: media, mimetype: 'image/webp' }, { upload: sock.waUploadToServer, logger });
        const message = { ...prepared.stickerMessage, isAnimated: !!animated };
        if (cacheKey)
            uploads.set(cacheKey, { at: Date.now(), sticker: message });
        return message;
    };
    const sendStickerReaction = async (key, stickers, options = {}) => {
        const { count = 1, delayMs = 0 } = options;
        const list = Array.isArray(stickers) ? stickers : [stickers];
        if (!list.length)
            throw new Boom('sendStickerReaction needs at least one sticker', { statusCode: 400 });
        if (!key?.remoteJid || !key.id) {
            throw new Boom('sendStickerReaction needs the key of the message to react to', { statusCode: 400 });
        }
        const total = Math.min(MAX_STICKER_REACTIONS, Math.max(1, Math.floor(count) || 1));
        // every distinct sticker is uploaded once and reused
        const uploaded = [];
        for (const sticker of list.slice(0, total)) {
            uploaded.push(await uploadSticker(sticker, options));
        }
        const ids = [];
        for (let i = 0; i < total; i++) {
            if (i > 0 && delayMs > 0)
                await delay(delayMs);
            const messageId = generateMessageIDV2(sock.user?.id);
            await sock.relayMessage(key.remoteJid, buildStickerReaction(uploaded[i % uploaded.length], key), { messageId });
            ids.push(messageId);
        }
        return ids;
    };
    const scheduler = createScheduler((jid, content, options) => sock.sendMessage(jid, content, options));
    const health = createHealthMonitor(sock.ev);
    const usernames = new Map();
    return {
        /**
         * Send a sticker carrying your pack name and author. A photo, GIF or
         * short video Buffer is converted to a sticker first.
         */
        sendSticker: async (jid, sticker, options = {}) => {
            const { pack, author, emojis, packId, convert, ...sendOptions } = options;
            if (!Buffer.isBuffer(sticker))
                throw new Boom('sendSticker needs a Buffer', { statusCode: 400 });
            const made = isWebp(sticker)
                ? { data: sticker, isAnimated: isAnimatedWebp(sticker) }
                : await makeStickerWebp(sticker, convert);
            const data = pack || author || emojis?.length ? addStickerExif(made.data, { pack, author, emojis, packId }) : made.data;
            return sock.sendMessage(jid, { sticker: data, isAnimated: made.isAnimated }, sendOptions);
        },
        /** send a message that deletes itself for everyone after `seconds` */
        sendSelfDestruct: async (jid, content, seconds, options = {}) => {
            if (!(seconds > 0) || seconds > 172800) {
                throw new Boom('sendSelfDestruct needs 1 to 172800 seconds (2 days)', { statusCode: 400 });
            }
            const message = await sock.sendMessage(jid, content, options);
            let timer;
            const done = new Promise(resolve => {
                timer = setTimeout(() => {
                    timer = undefined;
                    sock.sendMessage(jid, { delete: message.key }).then(() => resolve(true), () => resolve(false));
                }, seconds * 1000);
                timer.unref?.();
            });
            return {
                message,
                /** resolves true once the message was deleted */
                done,
                /** keep the message after all */
                cancel: () => {
                    if (!timer)
                        return false;
                    clearTimeout(timer);
                    timer = undefined;
                    return true;
                }
            };
        },
        /** the text appears piece by piece: one message that is edited until it is complete */
        sendTypewriter: async (jid, text, options = {}) => {
            const { steps = 6, delayMs = 700, ...sendOptions } = options;
            const frames = typewriterFrames(text, steps);
            const message = await sock.sendMessage(jid, { text: frames[0] }, sendOptions);
            for (const frame of frames.slice(1)) {
                await delay(Math.max(300, delayMs));
                await sock.sendMessage(jid, { text: frame, edit: message.key });
            }
            return message;
        },
        /** send later: `when` is a Date or a delay in ms. Kept in memory only. */
        schedule: scheduler.schedule,
        cancelScheduled: scheduler.cancel,
        listScheduled: scheduler.list,
        /** photo or video with a larger, sharper preview; the file itself is sent as it is */
        sendHD: (jid, content, options = {}) => {
            if (!('image' in content) && !('video' in content)) {
                throw new Boom('sendHD needs an image or a video', { statusCode: 400 });
            }
            return sock.sendMessage(jid, { ...content, hd: true }, options);
        },
        /** a whole sticker pack in one message; the receiver adds it with one tap */
        sendStickerPack: async (jid, pack) => {
            // check the name and the count first, so a bad pack costs no conversion or upload
            planStickerPack(pack, (pack?.stickers || []).map(() => ({ data: Buffer.from([0]) })));
            const items = [];
            for (const entry of pack?.stickers || []) {
                const item = Buffer.isBuffer(entry) ? { data: entry } : { ...entry };
                if (Buffer.isBuffer(item.data) && !isWebp(item.data)) {
                    const made = await makeStickerWebp(item.data, pack.convert);
                    item.data = made.data;
                    item.isAnimated = made.isAnimated;
                }
                else if (Buffer.isBuffer(item.data) && item.isAnimated === undefined) {
                    item.isAnimated = isAnimatedWebp(item.data);
                }
                items.push(item);
            }
            const { stickerPackId, files } = planStickerPack(pack, items);
            let trayIcon = pack.trayIcon;
            if (!trayIcon) {
                const sharp = await import('sharp').then(m => m.default, () => undefined);
                if (!sharp) {
                    throw new Boom('give a trayIcon (png), or install sharp so one can be made from the first sticker', {
                        statusCode: 501
                    });
                }
                trayIcon = await sharp(files[0].data)
                    .resize(252, 252, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
                    .png()
                    .toBuffer();
            }
            const trayIconFileName = 'tray.png';
            const zip = createStoredZip([
                ...files.map(f => ({ name: f.fileName, data: f.data })),
                { name: trayIconFileName, data: trayIcon }
            ]);
            const uploadPart = async (data, mediaType, mediaKey) => {
                const enc = await encryptedStream(data, mediaType, { logger, mediaKey });
                try {
                    const { directPath } = await sock.waUploadToServer(enc.encFilePath, {
                        fileEncSha256B64: enc.fileEncSha256.toString('base64'),
                        mediaType
                    });
                    return {
                        mediaKey: enc.mediaKey,
                        fileSha256: enc.fileSha256,
                        fileEncSha256: enc.fileEncSha256,
                        fileLength: enc.fileLength,
                        directPath
                    };
                }
                finally {
                    await fs.unlink(enc.encFilePath).catch(() => { });
                }
            };
            const packUpload = await uploadPart(zip, 'sticker-pack');
            const iconUpload = await uploadPart(trayIcon, 'thumbnail-sticker-pack', packUpload.mediaKey);
            const message = generateWAMessageFromContent(jid, buildStickerPackMessage({ ...pack, stickerPackId, trayIconFileName, zipLength: zip.length }, files, packUpload, iconUpload), { userJid: sock.user?.id });
            await sock.relayMessage(jid, message.message, { messageId: message.key.id });
            return { message, stickerPackId, stickers: files.length };
        },
        /** post a status inside a group (text, photo, video, voice or sticker) */
        sendGroupStatus: async (jid, content, options = {}) => {
            if (!jid?.endsWith('@g.us')) {
                throw new Boom('a group status can only go to a group', { statusCode: 400 });
            }
            const inner = await generateWAMessageContent(content, {
                ...options,
                upload: sock.waUploadToServer,
                logger
            });
            const me = sock.user?.lid || sock.user?.id;
            const message = generateWAMessageFromContent(jid, buildGroupStatusMessage(inner, me ? jidNormalizedUser(me) : undefined), { userJid: sock.user?.id });
            await sock.relayMessage(jid, message.message, { messageId: message.key.id });
            return message;
        },
        /** experimental: content hidden behind a tap-to-reveal blur */
        sendSpoiler: (jid, content, options = {}) => sock.sendMessage(jid, { ...content, spoiler: true }, options),
        /** find the account behind a WhatsApp @username */
        resolveUsername: async (username, pin) => {
            const name = String(username ?? '')
                .trim()
                .replace(/^@/, '')
                .toLowerCase();
            if (!/^[a-z0-9._]{3,35}$/.test(name)) {
                throw new Boom('that is not a valid WhatsApp username', { statusCode: 400 });
            }
            const cached = usernames.get(name);
            if (cached && Date.now() - cached.at < 10 * 60 * 1000)
                return cached.value;
            const user = new USyncUser().withUsername(name);
            if (pin)
                user.withUsernameKey(pin);
            const result = await sock.executeUSyncQuery(new USyncQuery().withContactProtocol().withUser(user));
            const entry = result?.list?.[0];
            let value = null;
            if (entry?.id) {
                const lid = isLidUser(entry.id) ? entry.id : undefined;
                let pn = isPnUser(entry.id) ? jidNormalizedUser(entry.id) : undefined;
                if (lid && !pn) {
                    pn = (await lookup.getPNForLID(lid).catch(() => undefined)) || undefined;
                    if (pn)
                        pn = jidNormalizedUser(pn);
                }
                value = { username: name, jid: pn || entry.id, lid, pn, exists: !!entry.contact };
            }
            usernames.set(name, { at: Date.now(), value });
            return value;
        },
        /** the @username of each given account (null when it has none) */
        fetchUsernames: async (...jids) => {
            const query = new USyncQuery().withUsernameProtocol();
            for (const jid of jids)
                query.withUser(new USyncUser().withId(jid));
            const result = await sock.executeUSyncQuery(query);
            return (result?.list || []).map(entry => ({
                jid: entry.id,
                username: typeof entry.username === 'string' ? entry.username : null
            }));
        },
        /** one snapshot of the connection: state, uptime, last message, disconnect count */
        health: (quietMs) => ({ ...health.report(quietMs), scheduled: scheduler.list().length }),
        /**
         * React to a message with one or more stickers / photos (the round
         * pictures WhatsApp shows around a message). Animated webp stays
         * animated; a photo, GIF or short video Buffer is converted first.
         */
        sendStickerReaction,
        /** call `handler` when an emoji is put on a message (default: only by the linked account) */
        onReactionTap: (handler, options) => createReactionTap(sock.ev, handler, options),
        /**
         * Emoji shortcut: when the linked account (or whoever `allow` accepts)
         * puts an emoji on a message, that message gets the sticker reactions.
         */
        stickerReactOnTap: (stickers, options = {}) => createReactionTap(sock.ev, event => sendStickerReaction(event.key, stickers, options), options),
        /** same person? works across phone number, bare digits and LID */
        isSameUser: (a, b) => isSameUser(a, b, lookup),
        /** phone-number JID and LID of a user, as far as they are known locally */
        resolveUserJids: (jid) => resolveUserJids(jid, lookup),
        /** send several photos / videos as one album */
        sendAlbum: async (jid, items, options = {}) => {
            if (!Array.isArray(items) || items.length < 2) {
                throw new Boom('sendAlbum needs at least 2 photos or videos', { statusCode: 400 });
            }
            const images = items.filter(item => 'image' in item).length;
            const videos = items.filter(item => 'video' in item).length;
            if (images + videos !== items.length) {
                throw new Boom('sendAlbum items must each have an image or a video', { statusCode: 400 });
            }
            const { delayMs = 0, ...sendOptions } = options;
            const parent = await sock.sendMessage(jid, { album: { expectedImageCount: images, expectedVideoCount: videos } }, sendOptions);
            if (!parent)
                throw new Boom('could not create the album', { statusCode: 500 });
            const sent = [];
            for (const [index, item] of items.entries()) {
                if (index > 0 && delayMs > 0)
                    await delay(delayMs);
                const message = await sock.sendMessage(jid, { ...item, albumParentKey: parent.key }, sendOptions);
                if (message)
                    sent.push(message);
            }
            return { album: parent, items: sent };
        },
        /**
         * Download the view-once photo / video / voice note in `message`, or in
         * the message it replies to.
         */
        downloadViewOnce: async (message, type) => {
            const content = extractViewOnceContent(message?.message);
            if (!content)
                throw new Boom('no view-once media in this message', { statusCode: 404 });
            assertViewOnceDownloadable(content);
            const data = await downloadMediaMessage({ key: message.key, message: content.message }, (type ?? 'buffer'), {}, { logger, reuploadRequest: sock.updateMediaMessage });
            return {
                type: content.type,
                mimetype: content.mimetype,
                caption: content.caption,
                data: data
            };
        },
        /** group metadata cache, kept fresh from the socket's group events */
        groupCache,
        /** group metadata from the cache (asks WhatsApp only when it is missing or `fresh` is true) */
        getGroup: (jid, fresh = false) => groupCache.get(jid, fresh),
        /** JIDs of the group's admins */
        groupAdmins: async (jid) => groupAdminsOf(await groupCache.get(jid)).map(p => p.id),
        /** is `user` an admin of the group? works with a number, a JID or a LID */
        isGroupAdmin: async (jid, user) => {
            const group = await groupCache.get(jid);
            const direct = findGroupParticipant(group, user);
            if (direct)
                return groupAdminsOf({ participants: [direct] }).length > 0;
            for (const admin of groupAdminsOf(group)) {
                if (await userMatches(admin, user))
                    return true;
            }
            return false;
        },
        /** is the linked account itself an admin of the group? */
        isBotAdmin: async (jid) => {
            const group = await groupCache.get(jid);
            const admins = groupAdminsOf(group);
            return [sock.user?.id, sock.user?.lid].some(me => !!me && !!findGroupParticipant({ participants: admins }, me));
        },
        /** mention everybody (or only the admins) in a group */
        tagAll: async (jid, text = '', options = {}) => {
            const { adminsOnly, showList, ...sendOptions } = options;
            const group = await groupCache.get(jid);
            const members = (adminsOnly ? groupAdminsOf(group) : group.participants).map(p => p.id);
            if (!members.length)
                throw new Boom('nobody to mention in this group', { statusCode: 404 });
            const list = showList ? '\n' + members.map(id => `@${id.split('@')[0].split(':')[0]}`).join('\n') : '';
            return sock.sendMessage(jid, { text: `${text}${list}`.trim() || '\u200e', mentions: members }, sendOptions);
        },
        /** text, sender, quoted, reply(), react() and download() for a received message */
        serialize: (message) => serializeMessage(sock, message, { download }),
        /** call `handler` with the original message when somebody deletes a message for everyone */
        onMessageDeleted: (handler, options) => createDeleteWatcher(sock.ev, handler, options),
        /** show "typing..." (or "recording...") for a moment, then send */
        sendWithTyping: async (jid, content, options = {}) => {
            const { typingMs, perCharMs, minMs, maxMs, ...sendOptions } = options;
            const wait = typingDelayFor(content, { typingMs, perCharMs, minMs, maxMs });
            const presence = 'audio' in content ? 'recording' : 'composing';
            if (wait > 0) {
                await sock.sendPresenceUpdate(presence, jid).catch(() => { });
                await delay(wait);
                await sock.sendPresenceUpdate('paused', jid).catch(() => { });
            }
            return sock.sendMessage(jid, content, sendOptions);
        },
        /** view, react to and collect incoming statuses */
        autoStatus: (options = {}) => createAutoStatus(sock, options, { download }),
        /** a queue that spaces out sendMessage calls, see createSendQueue */
        createSendQueue: (options) => createSendQueue(sock, options)
    };
};
/** DexBaileys helpers on top of the regular socket */
export const makeDexSocket = (config) => {
    if (config.quietSignalLogs !== false && process.env.DEX_BAILEYS_VERBOSE !== '1') {
        quietSignalLogs();
    }
    // group sends read the participants from the built-in cache unless the
    // caller brought a cache of their own
    const groupCache = createGroupCache();
    const ownCache = config.cachedGroupMetadata !== DEFAULT_CONNECTION_CONFIG.cachedGroupMetadata;
    const sock = makeCommunitiesSocket(ownCache
        ? config
        : {
            ...config,
            cachedGroupMetadata: async (jid) => jid.endsWith('@g.us') ? groupCache.get(jid).catch(() => undefined) : undefined
        });
    groupCache.bind(sock.ev);
    // membership changes made by this socket must not leave a stale entry behind
    const forget = (fn) => async (...args) => {
        try {
            return await fn(...args);
        }
        finally {
            groupCache.delete(args[0]);
        }
    };
    return {
        ...sock,
        groupParticipantsUpdate: forget(sock.groupParticipantsUpdate),
        groupRequestParticipantsUpdate: forget(sock.groupRequestParticipantsUpdate),
        groupLeave: forget(sock.groupLeave),
        ...makeDexHelpers(sock, config.logger, groupCache)
    };
};
//# sourceMappingURL=dex.js.map