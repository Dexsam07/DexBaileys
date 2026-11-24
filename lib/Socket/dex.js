import { Boom } from '@hapi/boom';
import { assertViewOnceDownloadable, buildStickerReaction, createSendQueue, delay, downloadMediaMessage, extractViewOnceContent, generateMessageIDV2, isSameUser, MAX_STICKER_REACTIONS, prepareWAMessageMedia, resolveUserJids } from '../Utils/index.js';
import { makeCommunitiesSocket } from './communities.js';
/** the DexBaileys helper methods, bound to a socket */
export const makeDexHelpers = (sock, logger) => {
    const lookup = {
        getLIDForPN: (pn) => sock.signalRepository.lidMapping.getLIDForPN(pn),
        getPNForLID: (lid) => sock.signalRepository.lidMapping.getPNForLID(lid)
    };
    return {
        /**
         * React to a message with one or more stickers / photos (the round
         * pictures WhatsApp shows around a message). `stickers` must be webp.
         */
        sendStickerReaction: async (key, stickers, { count = 1, delayMs = 0 } = {}) => {
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
                const media = await prepareWAMessageMedia({ sticker, mimetype: 'image/webp' }, { upload: sock.waUploadToServer, logger });
                uploaded.push(media.stickerMessage);
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
        },
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
        /** a queue that spaces out sendMessage calls, see createSendQueue */
        createSendQueue: (options) => createSendQueue(sock, options)
    };
};
/** DexBaileys helpers on top of the regular socket */
export const makeDexSocket = (config) => {
    const sock = makeCommunitiesSocket(config);
    return { ...sock, ...makeDexHelpers(sock, config.logger) };
};
//# sourceMappingURL=dex.js.map