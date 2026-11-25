import { Boom } from '@hapi/boom';
import { randomBytes, randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { dirname } from 'path';
import { proto } from '../../WAProto/index.js';
import { migrateSession } from './dex-plus.js';
import { useKeyValueAuthState } from './dex-store.js';
// ---------------------------------------------------------------------------
// zip (stored, no compression) — webp stickers do not shrink anyway
// ---------------------------------------------------------------------------
let crcTable;
/** CRC-32 of a buffer, as used by zip files */
export const crc32 = (data) => {
    if (!crcTable) {
        crcTable = new Uint32Array(256);
        for (let i = 0; i < 256; i++) {
            let value = i;
            for (let bit = 0; bit < 8; bit++) {
                value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
            }
            crcTable[i] = value >>> 0;
        }
    }
    let crc = 0xffffffff;
    for (const byte of data) {
        crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
};
/** Pack files into one zip archive without compressing them */
export const createStoredZip = (files) => {
    if (!files.length || files.length > 0xffff) {
        throw new Boom('a zip needs between 1 and 65535 files', { statusCode: 400 });
    }
    const seen = new Set();
    const stamp = new Date();
    const dosTime = (stamp.getHours() << 11) | (stamp.getMinutes() << 5) | (stamp.getSeconds() >> 1);
    const dosDate = (Math.max(stamp.getFullYear() - 1980, 0) << 9) | ((stamp.getMonth() + 1) << 5) | stamp.getDate();
    const body = [];
    const directory = [];
    let position = 0;
    for (const file of files) {
        if (!file.name || seen.has(file.name)) {
            throw new Boom(`zip file names must be unique and not empty: "${file.name}"`, { statusCode: 400 });
        }
        seen.add(file.name);
        const name = Buffer.from(file.name, 'utf8');
        const checksum = crc32(file.data);
        // the 26 bytes both headers share: version, flags (utf-8 names), method 0, time, date, crc, sizes, name length, extra length
        const shared = Buffer.alloc(26);
        shared.writeUInt16LE(20, 0);
        shared.writeUInt16LE(0x0800, 2);
        shared.writeUInt16LE(0, 4);
        shared.writeUInt16LE(dosTime, 6);
        shared.writeUInt16LE(dosDate, 8);
        shared.writeUInt32LE(checksum, 10);
        shared.writeUInt32LE(file.data.length, 14);
        shared.writeUInt32LE(file.data.length, 18);
        shared.writeUInt16LE(name.length, 22);
        shared.writeUInt16LE(0, 24);
        const local = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), shared, name]);
        body.push(local, file.data);
        const tail = Buffer.alloc(14);
        tail.writeUInt32LE(position, 10);
        directory.push(Buffer.from([0x50, 0x4b, 0x01, 0x02, 20, 0]), shared, tail, name);
        position += local.length + file.data.length;
    }
    const directoryBytes = Buffer.concat(directory);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(directoryBytes.length, 12);
    end.writeUInt32LE(position, 16);
    return Buffer.concat([...body, directoryBytes, end]);
};
// ---------------------------------------------------------------------------
// sticker pack
// ---------------------------------------------------------------------------
export const MAX_STICKERS_PER_PACK = 60;
/** Check a pack and give every sticker its file name */
export const planStickerPack = (info, stickers) => {
    if (!info?.name?.trim() || !info?.publisher?.trim()) {
        throw new Boom('a sticker pack needs a name and a publisher', { statusCode: 400 });
    }
    if (!Array.isArray(stickers) || !stickers.length || stickers.length > MAX_STICKERS_PER_PACK) {
        throw new Boom(`a sticker pack needs 1 to ${MAX_STICKERS_PER_PACK} stickers`, { statusCode: 400 });
    }
    const used = new Set();
    const files = stickers.map((sticker, index) => {
        if (!Buffer.isBuffer(sticker?.data) || !sticker.data.length) {
            throw new Boom(`sticker ${index + 1} has no data`, { statusCode: 400 });
        }
        let fileName = sticker.fileName || `sticker-${index}.webp`;
        while (used.has(fileName))
            fileName = `${index}-${fileName}`;
        used.add(fileName);
        return { ...sticker, fileName };
    });
    return { stickerPackId: info.stickerPackId || randomUUID(), files };
};
/** The message that carries an uploaded sticker pack */
export const buildStickerPackMessage = (info, files, pack, icon, messageSecret = randomBytes(32)) => ({
    messageContextInfo: { messageSecret },
    stickerPackMessage: {
        stickerPackId: info.stickerPackId,
        name: info.name,
        publisher: info.publisher,
        packDescription: info.description,
        caption: info.caption,
        stickers: files.map(file => ({
            fileName: file.fileName,
            isAnimated: !!file.isAnimated,
            emojis: file.emojis || [],
            accessibilityLabel: file.label || '',
            isLottie: false,
            mimetype: 'image/webp'
        })),
        fileLength: pack.fileLength,
        fileSha256: pack.fileSha256,
        fileEncSha256: pack.fileEncSha256,
        mediaKey: pack.mediaKey,
        directPath: pack.directPath,
        mediaKeyTimestamp: Math.floor(Date.now() / 1000),
        trayIconFileName: info.trayIconFileName,
        thumbnailDirectPath: icon.directPath,
        thumbnailSha256: icon.fileSha256,
        thumbnailEncSha256: icon.fileEncSha256,
        thumbnailHeight: 252,
        thumbnailWidth: 252,
        stickerPackSize: info.zipLength,
        stickerPackOrigin: proto.Message.StickerPackMessage.StickerPackOrigin.THIRD_PARTY
    }
});
// ---------------------------------------------------------------------------
// group status
// ---------------------------------------------------------------------------
const STATUS_MEDIA_KEYS = ['imageMessage', 'videoMessage', 'audioMessage', 'stickerMessage'];
/** Wrap ready message content so it shows as a status inside a group */
export const buildGroupStatusMessage = (inner, authorJid, messageSecret = randomBytes(32)) => {
    const content = { ...inner };
    for (const key of STATUS_MEDIA_KEYS) {
        if (!content[key])
            continue;
        content[key] = {
            ...content[key],
            contextInfo: {
                ...(content[key].contextInfo || {}),
                isGroupStatus: true,
                statusAttributions: authorJid
                    ? [{ type: proto.StatusAttribution.Type.GROUP_STATUS, groupStatus: { authorJid } }]
                    : [],
                featureEligibilities: { canReceiveMultiReact: true }
            }
        };
    }
    return {
        messageContextInfo: { messageSecret },
        groupStatusMessageV2: { message: { ...content, messageContextInfo: { messageSecret } } }
    };
};
/** A key-value store kept in one SQLite file. Needs Node 22.5 or newer. */
export const sqliteKeyValueStore = async (file, table = 'dex_session') => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
        throw new Boom('the table name may only use letters, numbers and _', { statusCode: 400 });
    }
    let DatabaseSync;
    try {
        const moduleName = 'node:sqlite';
        ({ DatabaseSync } = await import(moduleName));
    }
    catch {
        throw new Boom('the SQLite session needs Node 22.5 or newer; use useSingleFileAuthState on older Node', {
            statusCode: 501
        });
    }
    if (file !== ':memory:') {
        await fs.mkdir(dirname(file), { recursive: true });
    }
    const db = new DatabaseSync(file);
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec(`CREATE TABLE IF NOT EXISTS ${table} (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID`);
    const read = db.prepare(`SELECT v FROM ${table} WHERE k = ?`);
    const write = db.prepare(`INSERT INTO ${table} (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`);
    const remove = db.prepare(`DELETE FROM ${table} WHERE k = ?`);
    const removePrefix = db.prepare(`DELETE FROM ${table} WHERE substr(k, 1, ?) = ?`);
    const total = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`);
    let open = true;
    return {
        get: key => read.get(key)?.v,
        set: (key, value) => void write.run(key, value),
        delete: key => void remove.run(key),
        clear: prefix => void removePrefix.run(prefix.length, prefix),
        count: () => Number(total.get().n),
        close: () => {
            if (open) {
                open = false;
                db.close();
            }
        }
    };
};
/** Keep the whole login in one SQLite file. Needs Node 22.5 or newer. */
export const useSqliteAuthState = async (file, options = {}) => {
    const store = await sqliteKeyValueStore(file, options.table);
    try {
        const prefix = options.prefix ?? 'dex:';
        if (options.migrateFromFolder && !(await store.get(`${prefix}creds`))) {
            const exists = await fs.stat(options.migrateFromFolder).then(s => s.isDirectory(), () => false);
            if (exists) {
                await migrateSession({ folder: options.migrateFromFolder }, { store, prefix });
            }
        }
        const auth = await useKeyValueAuthState(store, { prefix, sessionId: options.sessionId });
        return { ...auth, store, close: store.close };
    }
    catch (error) {
        store.close();
        throw error;
    }
};
//# sourceMappingURL=dex-pack.js.map