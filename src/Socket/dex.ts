import { Boom } from '@hapi/boom'
import type { Transform } from 'stream'
import { DEFAULT_CONNECTION_CONFIG } from '../Defaults'
import type {
	AnyMediaMessageContent,
	AnyMessageContent,
	MiscMessageGenerationOptions,
	SocketConfig,
	WAMediaUpload,
	WAMessage,
	WAMessageKey
} from '../Types'
import {
	assertViewOnceDownloadable,
	type AutoStatusOptions,
	buildStickerReaction,
	createAutoStatus,
	createDeleteWatcher,
	createGroupCache,
	createReactionTap,
	createSendQueue,
	delay,
	type DeletedMessageEvent,
	type DeleteWatcherOptions,
	downloadMediaMessage,
	extractViewOnceContent,
	findGroupParticipant,
	generateMessageIDV2,
	type GroupCache,
	groupAdminsOf,
	isAnimatedWebp,
	isSameUser,
	isWebp,
	makeStickerWebp,
	MAX_STICKER_REACTIONS,
	prepareWAMessageMedia,
	type ReactionTapEvent,
	type ReactionTapOptions,
	resolveUserJids,
	type SendQueueOptions,
	serializeMessage,
	type StickerWebpOptions,
	typingDelayFor,
	type TypingOptions,
	type ViewOnceMediaType
} from '../Utils'
import { makeCommunitiesSocket } from './communities'

export type StickerReactionOptions = {
	/** how many sticker reactions to add (1 to 30, default 1) */
	count?: number
	/** wait between two reactions in ms (default 0) */
	delayMs?: number
	/** force the animated flag; by default it is read from the webp itself */
	animated?: boolean
	/** photos, GIFs and short videos given as a Buffer are turned into a sticker first (default true) */
	convert?: boolean | StickerWebpOptions
}

export type StickerTapOptions = ReactionTapOptions & StickerReactionOptions

export type AlbumItem = Extract<AnyMediaMessageContent, { image: WAMediaUpload } | { video: WAMediaUpload }>

type DexBase = Pick<
	ReturnType<typeof makeCommunitiesSocket>,
	'sendMessage' | 'relayMessage' | 'waUploadToServer' | 'updateMediaMessage' | 'signalRepository' | 'user' | 'ev' | 'sendPresenceUpdate' | 'groupMetadata' | 'readStatus' | 'reactToStatus'
>

/** the DexBaileys helper methods, bound to a socket */
export type TagAllOptions = MiscMessageGenerationOptions & {
	/** only mention the admins */
	adminsOnly?: boolean
	/** write the @numbers under the text (default false = hidden tag) */
	showList?: boolean
}

export const makeDexHelpers = (sock: DexBase, logger: SocketConfig['logger'], sharedGroupCache?: GroupCache) => {
	const groupCache = sharedGroupCache ?? createGroupCache()
	groupCache.setFetcher(jid => sock.groupMetadata(jid))
	if (!sharedGroupCache && sock.ev) groupCache.bind(sock.ev)

	const download = (message: WAMessage) =>
		downloadMediaMessage(message, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage }) as Promise<Buffer>

	const userMatches = async (participant: { id: string; lid?: string; phoneNumber?: string }, user: string) => {
		for (const candidate of [participant.id, participant.lid, participant.phoneNumber]) {
			if (candidate && (await isSameUser(candidate, user, lookup))) return true
		}

		return false
	}

	const lookup = {
		getLIDForPN: (pn: string) => sock.signalRepository.lidMapping.getLIDForPN(pn),
		getPNForLID: (lid: string) => sock.signalRepository.lidMapping.getPNForLID(lid)
	}

	// an uploaded sticker is reused for 6 hours, so repeated reactions do not upload again
	const UPLOAD_TTL_MS = 6 * 60 * 60 * 1000
	const uploads = new WeakMap<object, { at: number; sticker: NonNullable<ReturnType<typeof buildStickerReaction>['stickerMessage']> }>()

	const uploadSticker = async (sticker: WAMediaUpload, options: StickerReactionOptions) => {
		const cacheKey = typeof sticker === 'object' && sticker ? (sticker as object) : undefined
		const cached = cacheKey && uploads.get(cacheKey)
		if (cached && Date.now() - cached.at < UPLOAD_TTL_MS) return cached.sticker

		let media: WAMediaUpload = sticker
		let animated = options.animated
		if (Buffer.isBuffer(sticker)) {
			if (!isWebp(sticker) && options.convert !== false) {
				const made = await makeStickerWebp(sticker, typeof options.convert === 'object' ? options.convert : {})
				media = made.data
				animated ??= made.isAnimated
			} else {
				animated ??= isAnimatedWebp(sticker)
			}
		}

		const prepared = await prepareWAMessageMedia(
			{ sticker: media, mimetype: 'image/webp' },
			{ upload: sock.waUploadToServer, logger }
		)
		const message = { ...prepared.stickerMessage!, isAnimated: !!animated }
		if (cacheKey) uploads.set(cacheKey, { at: Date.now(), sticker: message })
		return message
	}

	const sendStickerReaction = async (
		key: WAMessageKey,
		stickers: WAMediaUpload | WAMediaUpload[],
		options: StickerReactionOptions = {}
	) => {
		const { count = 1, delayMs = 0 } = options
		const list = Array.isArray(stickers) ? stickers : [stickers]
		if (!list.length) throw new Boom('sendStickerReaction needs at least one sticker', { statusCode: 400 })
		if (!key?.remoteJid || !key.id) {
			throw new Boom('sendStickerReaction needs the key of the message to react to', { statusCode: 400 })
		}

		const total = Math.min(MAX_STICKER_REACTIONS, Math.max(1, Math.floor(count) || 1))
		// every distinct sticker is uploaded once and reused
		const uploaded = []
		for (const sticker of list.slice(0, total)) {
			uploaded.push(await uploadSticker(sticker, options))
		}

		const ids: string[] = []
		for (let i = 0; i < total; i++) {
			if (i > 0 && delayMs > 0) await delay(delayMs)
			const messageId = generateMessageIDV2(sock.user?.id)
			await sock.relayMessage(key.remoteJid, buildStickerReaction(uploaded[i % uploaded.length]!, key), { messageId })
			ids.push(messageId)
		}

		return ids
	}

	return {
		/**
		 * React to a message with one or more stickers / photos (the round
		 * pictures WhatsApp shows around a message). Animated webp stays
		 * animated; a photo, GIF or short video Buffer is converted first.
		 */
		sendStickerReaction,

		/** call `handler` when an emoji is put on a message (default: only by the linked account) */
		onReactionTap: (handler: (event: ReactionTapEvent) => unknown, options?: ReactionTapOptions) =>
			createReactionTap(sock.ev, handler, options),

		/**
		 * Emoji shortcut: when the linked account (or whoever `allow` accepts)
		 * puts an emoji on a message, that message gets the sticker reactions.
		 */
		stickerReactOnTap: (stickers: WAMediaUpload | WAMediaUpload[], options: StickerTapOptions = {}) =>
			createReactionTap(sock.ev, event => sendStickerReaction(event.key, stickers, options), options),

		/** same person? works across phone number, bare digits and LID */
		isSameUser: (a: string | undefined | null, b: string | undefined | null) => isSameUser(a, b, lookup),

		/** phone-number JID and LID of a user, as far as they are known locally */
		resolveUserJids: (jid: string) => resolveUserJids(jid, lookup),

		/** send several photos / videos as one album */
		sendAlbum: async (
			jid: string,
			items: AlbumItem[],
			options: MiscMessageGenerationOptions & { delayMs?: number } = {}
		) => {
			if (!Array.isArray(items) || items.length < 2) {
				throw new Boom('sendAlbum needs at least 2 photos or videos', { statusCode: 400 })
			}

			const images = items.filter(item => 'image' in item).length
			const videos = items.filter(item => 'video' in item).length
			if (images + videos !== items.length) {
				throw new Boom('sendAlbum items must each have an image or a video', { statusCode: 400 })
			}

			const { delayMs = 0, ...sendOptions } = options
			const parent = await sock.sendMessage(
				jid,
				{ album: { expectedImageCount: images, expectedVideoCount: videos } },
				sendOptions
			)
			if (!parent) throw new Boom('could not create the album', { statusCode: 500 })

			const sent: WAMessage[] = []
			for (const [index, item] of items.entries()) {
				if (index > 0 && delayMs > 0) await delay(delayMs)
				const message = await sock.sendMessage(
					jid,
					{ ...item, albumParentKey: parent.key } as AnyMediaMessageContent,
					sendOptions
				)
				if (message) sent.push(message)
			}

			return { album: parent, items: sent }
		},

		/**
		 * Download the view-once photo / video / voice note in `message`, or in
		 * the message it replies to.
		 */
		downloadViewOnce: async <T extends 'buffer' | 'stream' = 'buffer'>(message: WAMessage, type?: T) => {
			const content = extractViewOnceContent(message?.message)
			if (!content) throw new Boom('no view-once media in this message', { statusCode: 404 })
			assertViewOnceDownloadable(content)

			const data = await downloadMediaMessage(
				{ key: message.key, message: content.message },
				(type ?? 'buffer') as T,
				{},
				{ logger, reuploadRequest: sock.updateMediaMessage }
			)
			return {
				type: content.type as ViewOnceMediaType,
				mimetype: content.mimetype,
				caption: content.caption,
				data: data as unknown as T extends 'stream' ? Transform : Buffer
			}
		},

		/** group metadata cache, kept fresh from the socket's group events */
		groupCache,

		/** group metadata from the cache (asks WhatsApp only when it is missing or `fresh` is true) */
		getGroup: (jid: string, fresh = false) => groupCache.get(jid, fresh),

		/** JIDs of the group's admins */
		groupAdmins: async (jid: string) => groupAdminsOf(await groupCache.get(jid)).map(p => p.id),

		/** is `user` an admin of the group? works with a number, a JID or a LID */
		isGroupAdmin: async (jid: string, user: string) => {
			const group = await groupCache.get(jid)
			const direct = findGroupParticipant(group, user)
			if (direct) return groupAdminsOf({ participants: [direct] }).length > 0
			for (const admin of groupAdminsOf(group)) {
				if (await userMatches(admin, user)) return true
			}

			return false
		},

		/** is the linked account itself an admin of the group? */
		isBotAdmin: async (jid: string) => {
			const group = await groupCache.get(jid)
			const admins = groupAdminsOf(group)
			return [sock.user?.id, sock.user?.lid].some(me => !!me && !!findGroupParticipant({ participants: admins }, me))
		},

		/** mention everybody (or only the admins) in a group */
		tagAll: async (jid: string, text = '', options: TagAllOptions = {}) => {
			const { adminsOnly, showList, ...sendOptions } = options
			const group = await groupCache.get(jid)
			const members = (adminsOnly ? groupAdminsOf(group) : group.participants).map(p => p.id)
			if (!members.length) throw new Boom('nobody to mention in this group', { statusCode: 404 })
			const list = showList ? '\n' + members.map(id => `@${id.split('@')[0]!.split(':')[0]}`).join('\n') : ''
			return sock.sendMessage(jid, { text: `${text}${list}`.trim() || '\u200e', mentions: members }, sendOptions)
		},

		/** text, sender, quoted, reply(), react() and download() for a received message */
		serialize: (message: WAMessage) => serializeMessage(sock, message, { download }),

		/** call `handler` with the original message when somebody deletes a message for everyone */
		onMessageDeleted: (handler: (event: DeletedMessageEvent) => unknown, options?: DeleteWatcherOptions) =>
			createDeleteWatcher(sock.ev, handler, options),

		/** show "typing..." (or "recording...") for a moment, then send */
		sendWithTyping: async (
			jid: string,
			content: AnyMessageContent,
			options: MiscMessageGenerationOptions & TypingOptions = {}
		) => {
			const { typingMs, perCharMs, minMs, maxMs, ...sendOptions } = options
			const wait = typingDelayFor(content, { typingMs, perCharMs, minMs, maxMs })
			const presence = 'audio' in content ? 'recording' : 'composing'
			if (wait > 0) {
				await sock.sendPresenceUpdate(presence, jid).catch(() => {})
				await delay(wait)
				await sock.sendPresenceUpdate('paused', jid).catch(() => {})
			}

			return sock.sendMessage(jid, content, sendOptions)
		},

		/** view, react to and collect incoming statuses */
		autoStatus: (options: AutoStatusOptions = {}) => createAutoStatus(sock, options, { download }),

		/** a queue that spaces out sendMessage calls, see createSendQueue */
		createSendQueue: (options?: SendQueueOptions) => createSendQueue(sock, options)
	}
}

/** DexBaileys helpers on top of the regular socket */
export const makeDexSocket = (config: SocketConfig) => {
	// group sends read the participants from the built-in cache unless the
	// caller brought a cache of their own
	const groupCache = createGroupCache()
	const ownCache = config.cachedGroupMetadata !== DEFAULT_CONNECTION_CONFIG.cachedGroupMetadata
	const sock = makeCommunitiesSocket(
		ownCache
			? config
			: {
					...config,
					cachedGroupMetadata: async (jid: string) =>
						jid.endsWith('@g.us') ? groupCache.get(jid).catch(() => undefined) : undefined
				}
	)
	groupCache.bind(sock.ev)

	// membership changes made by this socket must not leave a stale entry behind
	const forget =
		<A extends [string, ...any[]], R>(fn: (...args: A) => Promise<R>) =>
		async (...args: A) => {
			try {
				return await fn(...args)
			} finally {
				groupCache.delete(args[0])
			}
		}

	return {
		...sock,
		groupParticipantsUpdate: forget(sock.groupParticipantsUpdate),
		groupRequestParticipantsUpdate: forget(sock.groupRequestParticipantsUpdate),
		groupLeave: forget(sock.groupLeave),
		...makeDexHelpers(sock, config.logger, groupCache)
	}
}
