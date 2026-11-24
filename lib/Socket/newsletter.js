import { QueryIds, XWAPaths } from '../Types/index.js';
import { generateProfilePicture } from '../Utils/messages-media.js';
import { getBinaryNodeChild } from '../WABinary/index.js';
import { makeGroupsSocket } from './groups.js';
import { executeWMexQuery as genericExecuteWMexQuery } from './mex.js';
/** Accept a bare invite code or a WhatsApp channel/post permalink. */
const extractNewsletterInviteCode = (value) => {
    const trimmed = String(value || '').trim();
    if (!trimmed) {
        throw new Error('Newsletter invite code or channel URL is required');
    }
    // URL() needs a scheme. Keep bare invite codes untouched, while allowing
    // whatsapp.com/channel/<code>/<post-id>?... links used by channel shares.
    const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    try {
        const url = new URL(candidate);
        const host = url.hostname.toLowerCase().replace(/^www\./, '');
        if (host === 'whatsapp.com' || host === 'm.whatsapp.com') {
            const match = url.pathname.match(/^\/channel\/([^/]+)(?:\/[^/]+)?\/?$/i);
            if (match?.[1])
                return decodeURIComponent(match[1]);
            throw new Error('Invalid WhatsApp Channel invite link');
        }
    }
    catch (error) {
        // A bare invite code is expected and should pass through unchanged.
        if (/^https?:\/\//i.test(trimmed) || trimmed.includes('whatsapp.com/')) {
            throw error;
        }
    }
    return trimmed;
};
const parseNewsletterCreateResponse = (response) => {
    const { id, thread_metadata: thread, viewer_metadata: viewer } = response;
    return {
        id: id,
        owner: undefined,
        name: thread.name.text,
        creation_time: parseInt(thread.creation_time, 10),
        description: thread.description.text,
        invite: thread.invite,
        subscribers: parseInt(thread.subscribers_count, 10),
        verification: thread.verification,
        picture: {
            id: thread.picture.id,
            directPath: thread.picture.direct_path
        },
        mute_state: viewer.mute
    };
};
const parseNewsletterMetadata = (result) => {
    if (typeof result !== 'object' || result === null) {
        return null;
    }
    // Already-flat shape: { id, name, invite, ... }
    if ('id' in result && typeof result.id === 'string') {
        // If it also has thread_metadata, parse it properly rather than returning raw.
        const r = result;
        if (r.thread_metadata && typeof r.thread_metadata === 'object') {
            return parseNewsletterCreateResponse(result);
        }
        return result;
    }
    // Wrapped in result key (legacy)
    if ('result' in result && typeof result.result === 'object' && result.result !== null) {
        return parseNewsletterMetadata(result.result);
    }
    // Raw GraphQL shape from METADATA query:
    // { id, state, thread_metadata: { name: { text }, invite, ... }, viewer_metadata: { mute } }
    // This is identical to NewsletterCreateResponse — reuse that parser.
    const r = result;
    if (r.thread_metadata && typeof r.thread_metadata === 'object') {
        try {
            return parseNewsletterCreateResponse(result);
        }
        catch {
            // Partial data — build best-effort flat object
            const thread = r.thread_metadata;
            const nameObj = thread.name;
            const name = typeof thread.name === 'string' ? thread.name : (nameObj?.text ?? 'Unknown');
            return {
                id: r.id ?? '',
                name,
                invite: thread.invite,
                description: thread.description?.text,
                subscribers: thread.subscribers_count ? parseInt(thread.subscribers_count, 10) : undefined,
                verification: thread.verification
            };
        }
    }
    return null;
};
export const makeNewsletterSocket = (config) => {
    const sock = makeGroupsSocket(config);
    const { query, generateMessageTag } = sock;
    const executeWMexQuery = (variables, queryId, dataPath) => {
        return genericExecuteWMexQuery(variables, queryId, dataPath, query, generateMessageTag);
    };
    const newsletterUpdate = async (jid, updates) => {
        const variables = {
            newsletter_id: jid,
            updates: {
                ...updates,
                settings: null
            }
        };
        return executeWMexQuery(variables, QueryIds.UPDATE_METADATA, 'xwa2_newsletter_update');
    };
    const newsletterMetadata = async (type, key) => {
        const lookupKey = type === 'invite' ? extractNewsletterInviteCode(key) : key.trim();
        const variables = {
            fetch_creation_time: true,
            fetch_full_image: true,
            fetch_viewer_metadata: true,
            input: { key: lookupKey, type: type.toUpperCase() }
        };
        const result = await executeWMexQuery(variables, QueryIds.METADATA, XWAPaths.xwa2_newsletter_metadata);
        return parseNewsletterMetadata(result);
    };
    const newsletterJidFromInvite = async (inviteOrUrl) => {
        const metadata = await newsletterMetadata('invite', inviteOrUrl);
        if (!metadata?.id?.endsWith('@newsletter')) {
            throw new Error('Unable to resolve WhatsApp Channel JID from the supplied invite link');
        }
        return metadata.id;
    };
    return {
        ...sock,
        newsletterCreate: async (name, description) => {
            const variables = {
                input: {
                    name,
                    description: description ?? null
                }
            };
            const rawResponse = await executeWMexQuery(variables, QueryIds.CREATE, XWAPaths.xwa2_newsletter_create);
            return parseNewsletterCreateResponse(rawResponse);
        },
        newsletterUpdate,
        newsletterSubscribers: async (jid) => {
            return executeWMexQuery({ newsletter_id: jid }, QueryIds.SUBSCRIBERS, XWAPaths.xwa2_newsletter_subscribers);
        },
        /** channels this account follows or owns (raw server list) */
        newsletterSubscribed: async () => {
            const result = await executeWMexQuery({}, QueryIds.SUBSCRIBED, XWAPaths.xwa2_newsletter_subscribed);
            return Array.isArray(result) ? result : [];
        },
        newsletterMetadata,
        newsletterJidFromInvite,
        newsletterFollow: async (jid) => {
            const result = await executeWMexQuery({ newsletter_id: jid }, QueryIds.FOLLOW, XWAPaths.xwa2_newsletter_join_v2);
            // Following a newsletter and subscribing to its live updates are separate
            // operations. Subscribe immediately so plaintext post notifications (including
            // pollCreationMessage + messageSecret) can reach the newsletter event pipeline.
            await query({
                tag: 'iq',
                attrs: {
                    id: generateMessageTag(),
                    type: 'set',
                    xmlns: 'newsletter',
                    to: jid
                },
                content: [{ tag: 'live_updates', attrs: {}, content: [] }]
            });
            return result;
        },
        newsletterUnfollow: (jid) => {
            return executeWMexQuery({ newsletter_id: jid }, QueryIds.UNFOLLOW, XWAPaths.xwa2_newsletter_leave_v2);
        },
        newsletterMute: (jid) => {
            return executeWMexQuery({ newsletter_id: jid }, QueryIds.MUTE, XWAPaths.xwa2_newsletter_mute_v2);
        },
        newsletterUnmute: (jid) => {
            return executeWMexQuery({ newsletter_id: jid }, QueryIds.UNMUTE, XWAPaths.xwa2_newsletter_unmute_v2);
        },
        newsletterUpdateName: async (jid, name) => {
            return await newsletterUpdate(jid, { name });
        },
        newsletterUpdateDescription: async (jid, description) => {
            return await newsletterUpdate(jid, { description });
        },
        newsletterUpdatePicture: async (jid, content) => {
            const { img } = await generateProfilePicture(content);
            return await newsletterUpdate(jid, { picture: img.toString('base64') });
        },
        newsletterRemovePicture: async (jid) => {
            return await newsletterUpdate(jid, { picture: '' });
        },
        /**
         * Submit a channel poll vote using SHA-256 hashes of the exact original optionName values.
         * Option hashes must be resolved from the decoded poll in the newsletter.message event.
         */
        newsletterVotePoll: async (jid, serverId, optionHashes) => {
            if (!jid?.endsWith('@newsletter'))
                throw new Error('A valid newsletter JID is required.');
            if (!/^\d+$/.test(String(serverId)))
                throw new Error('A valid channel post server ID is required.');
            if (!Array.isArray(optionHashes) || !optionHashes.length)
                throw new Error('At least one poll option hash is required.');
            for (const hash of optionHashes) {
                if (!(hash instanceof Uint8Array) || hash.byteLength !== 32)
                    throw new Error('Each poll option must be a 32-byte SHA-256 hash.');
            }
            const messageTag = generateMessageTag();
            const ack = await query({
                tag: 'message',
                attrs: { to: jid, type: 'poll', server_id: String(serverId), id: messageTag },
                content: [
                    { tag: 'meta', attrs: { polltype: 'vote' } },
                    { tag: 'votes', attrs: {}, content: optionHashes.map(hash => ({ tag: 'vote', attrs: {}, content: Buffer.from(hash) })) }
                ]
            }, 15000);
            if (ack?.attrs?.error)
                throw new Error('WhatsApp rejected channel poll vote: ' + String(ack.attrs.error));
            if (ack?.tag !== 'ack' || ack.attrs?.id !== messageTag || ack.attrs?.class !== 'message') {
                throw new Error('Unexpected WhatsApp acknowledgement; channel poll vote is unconfirmed.');
            }
            return { ok: true, serverId: String(serverId), optionCount: optionHashes.length };
        },
        newsletterReactMessage: async (jid, serverId, reaction) => {
            await query({
                tag: 'message',
                attrs: {
                    to: jid,
                    ...(reaction ? {} : { edit: '7' }),
                    type: 'reaction',
                    server_id: serverId,
                    id: generateMessageTag()
                },
                content: [
                    {
                        tag: 'reaction',
                        attrs: reaction ? { code: reaction } : {}
                    }
                ]
            });
        },
        newsletterFetchMessages: async (jid, count, since, after) => {
            const messageUpdateAttrs = {
                count: count.toString()
            };
            if (typeof since === 'number') {
                messageUpdateAttrs.since = since.toString();
            }
            if (after) {
                messageUpdateAttrs.after = after.toString();
            }
            const result = await query({
                tag: 'iq',
                attrs: {
                    id: generateMessageTag(),
                    type: 'get',
                    xmlns: 'newsletter',
                    to: jid
                },
                content: [
                    {
                        tag: 'message_updates',
                        attrs: messageUpdateAttrs
                    }
                ]
            });
            return result;
        },
        subscribeNewsletterUpdates: async (jid) => {
            const result = await query({
                tag: 'iq',
                attrs: {
                    id: generateMessageTag(),
                    type: 'set',
                    xmlns: 'newsletter',
                    to: jid
                },
                content: [{ tag: 'live_updates', attrs: {}, content: [] }]
            });
            const liveUpdatesNode = getBinaryNodeChild(result, 'live_updates');
            const duration = liveUpdatesNode?.attrs?.duration;
            return duration ? { duration: duration } : null;
        },
        newsletterAdminCount: async (jid) => {
            const response = await executeWMexQuery({ newsletter_id: jid }, QueryIds.ADMIN_COUNT, XWAPaths.xwa2_newsletter_admin_count);
            return response.admin_count;
        },
        newsletterChangeOwner: async (jid, newOwnerJid) => {
            await executeWMexQuery({ newsletter_id: jid, user_id: newOwnerJid }, QueryIds.CHANGE_OWNER, XWAPaths.xwa2_newsletter_change_owner);
        },
        newsletterDemote: async (jid, userJid) => {
            await executeWMexQuery({ newsletter_id: jid, user_id: userJid }, QueryIds.DEMOTE, XWAPaths.xwa2_newsletter_demote);
        },
        newsletterDelete: async (jid) => {
            await executeWMexQuery({ newsletter_id: jid }, QueryIds.DELETE, XWAPaths.xwa2_newsletter_delete_v2);
        }
    };
};
//# sourceMappingURL=newsletter.js.map