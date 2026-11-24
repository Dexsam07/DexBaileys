import { Boom } from '@hapi/boom';
import { getBinaryNodeChild, S_WHATSAPP_NET } from '../WABinary/index.js';
const wMexQuery = (variables, queryId, query, generateMessageTag) => query({
    tag: 'iq',
    attrs: { id: generateMessageTag(), type: 'get', to: S_WHATSAPP_NET, xmlns: 'w:mex' },
    content: [{
            tag: 'query',
            attrs: { query_id: queryId },
            content: Buffer.from(JSON.stringify({ variables }), 'utf-8')
        }]
});
const asText = (value) => {
    if (typeof value === 'string')
        return value;
    if (value instanceof Uint8Array)
        return Buffer.from(value).toString('utf8');
    return null;
};
const parseJsonCandidate = (raw) => {
    const candidates = [raw.trim()];
    for (const marker of ['{', '[']) {
        const index = raw.indexOf(marker);
        if (index > 0)
            candidates.push(raw.slice(index).trim());
    }
    for (const candidate of candidates) {
        if (!candidate.startsWith('{') && !candidate.startsWith('['))
            continue;
        try {
            const parsed = JSON.parse(candidate);
            if (Array.isArray(parsed)) {
                const match = parsed.find(item => item && typeof item === 'object' && !Array.isArray(item));
                if (match)
                    return match;
            }
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
                return parsed;
        }
        catch {
            // Continue trying the next possible JSON boundary.
        }
    }
    return null;
};
/** Tolerant WMex JSON reader: handles UTF-8/Latin-1 bytes and leading binary noise. */
export const parseWMexJson = (content) => {
    if (typeof content === 'undefined' || content === null || Array.isArray(content))
        return null;
    const raw = asText(content);
    if (!raw)
        return null;
    return parseJsonCandidate(raw.replace(/^\uFEFF/, '')) ||
        parseJsonCandidate(Buffer.from(raw, 'utf8').toString('latin1'));
};
export const extractNewsletterJidFromBinaryNode = (node) => {
    const candidates = new Set();
    const scan = (value) => {
        const text = asText(value);
        if (!text)
            return;
        for (const match of text.matchAll(/(?<![0-9])(120363\d{7,18})(?![0-9])/g)) {
            candidates.add(match[1] + '@newsletter');
        }
    };
    const visit = (current, depth = 0) => {
        if (!current || depth > 10)
            return;
        for (const value of Object.values(current.attrs || {}))
            scan(value);
        if (Array.isArray(current.content)) {
            for (const child of current.content)
                visit(child, depth + 1);
        }
        else {
            scan(current.content);
        }
    };
    visit(node);
    return candidates.size === 1 ? [...candidates][0] : null;
};
const fieldAliases = {
    name: 'name', channel_name: 'name', title: 'name',
    description: 'description', desc: 'description', invite: 'invite',
    creation_time: 'creation_time', created_at: 'creation_time',
    subscribers: 'subscribers', subscriber_count: 'subscribers',
    subscribers_count: 'subscribers', followers: 'subscribers', followers_count: 'subscribers',
    verification: 'verification', owner: 'owner',
    direct_path: 'picture_direct_path', directpath: 'picture_direct_path',
    picture_id: 'picture_id', media_key: 'picture_media_key'
};
const scalarText = (value) => asText(value)?.trim() || null;
/**
 * Best-effort decoder for structured newsletter metadata in a BinaryNode tree.
 * It extracts tagged/attributed fields and embedded JSON. Opaque binary formats
 * without field boundaries cannot be safely guessed.
 */
export const extractNewsletterMetadataFromBinaryNode = (node) => {
    if (!node)
        return null;
    const fields = {};
    const ids = new Set();
    const capture = (key, value) => {
        const normalized = key.toLowerCase().replace(/[-\s]/g, '_');
        const mapped = fieldAliases[normalized];
        const text = scalarText(value);
        if (!text)
            return;
        if (normalized === 'id' || normalized === 'newsletter_id' || normalized === 'jid') {
            const match = text.match(/(?:^|[^0-9])(120363\d{7,18})(?:@newsletter)?(?:$|[^0-9])/);
            if (match)
                ids.add(match[1] + '@newsletter');
            return;
        }
        if (mapped && !fields[mapped])
            fields[mapped] = text;
    };
    const walkJson = (value) => {
        if (!value || typeof value !== 'object')
            return;
        if (Array.isArray(value)) {
            for (const item of value)
                walkJson(item);
            return;
        }
        for (const [key, item] of Object.entries(value)) {
            if (typeof item === 'string' || typeof item === 'number')
                capture(key, item);
            else {
                const nested = item;
                if (nested && typeof nested.text === 'string')
                    capture(key, nested.text);
                walkJson(item);
            }
        }
    };
    const visit = (current, depth = 0, parentTag = '') => {
        if (!current || depth > 10)
            return;
        capture(current.tag, current.content);
        if (current.tag.toLowerCase() === 'text' && parentTag)
            capture(parentTag, current.content);
        for (const [key, value] of Object.entries(current.attrs || {})) {
            capture(current.tag.toLowerCase() === 'picture' && key === 'id' ? 'picture_id' : key, value);
        }
        if (Array.isArray(current.content)) {
            for (const child of current.content)
                visit(child, depth + 1, current.tag);
        }
        else {
            const raw = scalarText(current.content);
            if (raw) {
                const json = parseJsonCandidate(raw);
                if (json)
                    walkJson(json);
            }
        }
    };
    visit(node);
    const recoveredId = extractNewsletterJidFromBinaryNode(node);
    if (recoveredId)
        ids.add(recoveredId);
    if (ids.size !== 1)
        return null;
    const metadata = { id: [...ids][0] };
    if (fields.name)
        metadata.name = fields.name;
    if (fields.description)
        metadata.description = fields.description;
    if (fields.invite)
        metadata.invite = fields.invite;
    if (fields.owner)
        metadata.owner = fields.owner;
    if (fields.creation_time && Number.isFinite(Number(fields.creation_time))) {
        metadata.creation_time = Number(fields.creation_time);
    }
    if (fields.subscribers && Number.isFinite(Number(fields.subscribers))) {
        metadata.subscribers = Number(fields.subscribers);
    }
    if (fields.verification === 'VERIFIED' || fields.verification === 'UNVERIFIED') {
        metadata.verification = fields.verification;
    }
    if (fields.picture_direct_path || fields.picture_id || fields.picture_media_key) {
        metadata.picture = {
            directPath: fields.picture_direct_path,
            id: fields.picture_id,
            mediaKey: fields.picture_media_key
        };
    }
    return metadata;
};
export const executeWMexQuery = async (variables, queryId, dataPath, query, generateMessageTag) => {
    const result = await wMexQuery(variables, queryId, query, generateMessageTag);
    const child = getBinaryNodeChild(result, 'result');
    const action = (dataPath || '').startsWith('xwa2_')
        ? dataPath.substring(5).replace(/_/g, ' ')
        : dataPath?.replace(/_/g, ' ');
    if (child) {
        const data = parseWMexJson(child.content);
        if (!data) {
            if (dataPath === 'xwa2_newsletter_metadata' || dataPath === 'xwa2_newsletter') {
                const metadata = extractNewsletterMetadataFromBinaryNode(child);
                if (metadata)
                    return metadata;
                const id = extractNewsletterJidFromBinaryNode(child);
                if (id)
                    return { id };
            }
            throw new Boom('Failed to parse ' + action + ' response: expected a JSON WMex result.', {
                statusCode: 502,
                data: { queryId, dataPath, responseTag: result.tag, responseAttrs: result.attrs }
            });
        }
        const errors = Array.isArray(data.errors) ? data.errors : [];
        if (errors.length) {
            const first = errors[0];
            const messages = errors.map((item) => item.message || 'Unknown error').join(', ');
            throw new Boom('GraphQL server error: ' + messages, {
                statusCode: first.extensions?.error_code || 400,
                data: first
            });
        }
        const root = data.data && typeof data.data === 'object' ? data.data : undefined;
        const response = dataPath ? root?.[dataPath] : root;
        if (typeof response !== 'undefined')
            return response;
    }
    throw new Boom('Failed to ' + action + ', unexpected response structure.', {
        statusCode: 400,
        data: { responseTag: result.tag, responseAttrs: result.attrs }
    });
};
//# sourceMappingURL=mex.js.map