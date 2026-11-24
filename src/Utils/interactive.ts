import { Boom } from '@hapi/boom'
import { proto } from '../../WAProto/index.js'
import type {
	ButtonsMessageContent,
	CarouselCard,
	CarouselMessageContent,
	InteractiveListSection,
	ListMessageContent,
	MessageContentGenerationOptions,
	NativeFlowButton,
	NativeFlowMessageContent,
	WAMessageContent
} from '../Types'

type MediaPreparer = (media: any, options: MessageContentGenerationOptions) => Promise<WAMessageContent>

const has = (obj: unknown, key: string): boolean =>
	obj !== null && typeof obj === 'object' && key in (obj as object) && (obj as any)[key] !== null && (obj as any)[key] !== undefined

const bad = (message: string) => new Boom(message, { statusCode: 400 })

/** True when the content asks for buttons, a list, native flow buttons or a carousel */
export const hasInteractiveContent = (message: unknown): boolean =>
	(has(message, 'buttons') && Array.isArray((message as any).buttons)) ||
	(has(message, 'sections') && Array.isArray((message as any).sections)) ||
	(has(message, 'nativeFlow') && Array.isArray((message as any).nativeFlow)) ||
	(has(message, 'cards') && Array.isArray((message as any).cards))

const normalizeSections = (sections: InteractiveListSection[]) =>
	sections.map(section => ({
		title: section.title || '',
		rows: (section.rows || []).map(row => ({
			title: row.title,
			description: row.description,
			header: row.header,
			id: row.id ?? row.rowId ?? row.title
		}))
	}))

/** Convert the friendly button shapes into WhatsApp native flow buttons */
export const prepareNativeFlowButtons = (
	buttons: NativeFlowButton[] = []
): proto.Message.InteractiveMessage.INativeFlowMessage => ({
	buttons: buttons.map(button => {
		if (has(button, 'name') && has(button, 'buttonParamsJson')) {
			const raw = button as { name: string; buttonParamsJson: string }
			return { name: raw.name, buttonParamsJson: raw.buttonParamsJson }
		}

		const b = button as any
		const icon: string | undefined = typeof b.icon === 'string' ? b.icon.toUpperCase() : undefined
		if (has(b, 'id')) {
			return {
				name: 'quick_reply',
				buttonParamsJson: JSON.stringify({ display_text: b.text || 'Click', id: String(b.id), icon })
			}
		}

		if (has(b, 'copy')) {
			return {
				name: 'cta_copy',
				buttonParamsJson: JSON.stringify({ display_text: b.text || 'Copy', copy_code: String(b.copy), icon })
			}
		}

		if (has(b, 'url')) {
			return {
				name: 'cta_url',
				buttonParamsJson: JSON.stringify({
					display_text: b.text || 'Open',
					url: b.url,
					merchant_url: b.url,
					webview_interaction: b.useWebview,
					icon
				})
			}
		}

		if (has(b, 'call')) {
			return {
				name: 'cta_call',
				buttonParamsJson: JSON.stringify({ display_text: b.text || 'Call', phone_number: String(b.call), icon })
			}
		}

		if (has(b, 'sections')) {
			return {
				name: 'single_select',
				buttonParamsJson: JSON.stringify({ title: b.text || 'Select', sections: normalizeSections(b.sections), icon })
			}
		}

		throw bad('Invalid nativeFlow button: give id, url, copy, call, sections or name + buttonParamsJson')
	}),
	messageParamsJson: JSON.stringify({})
})

const pickHeaderMedia = (source: any, allowDocument: boolean) => {
	const kinds = allowDocument ? ['image', 'video', 'document'] : ['image', 'video']
	const present = kinds.filter(kind => has(source, kind))
	if (present.length > 1) {
		throw bad('Give only one header media (image, video or document)')
	}

	const kind = present[0]
	if (!kind) {
		return undefined
	}

	const media: any = { [kind]: source[kind] }
	if (kind === 'document') {
		media.mimetype = source.mimetype || 'application/octet-stream'
		if (source.fileName) {
			media.fileName = source.fileName
		}
	} else if (source.mimetype) {
		media.mimetype = source.mimetype
	}

	return media
}

const bodyText = (message: { text?: string; caption?: string }) => message.caption ?? message.text ?? ''

const buildButtonsMessage = async (
	message: ButtonsMessageContent,
	options: MessageContentGenerationOptions,
	prepareMedia: MediaPreparer
): Promise<WAMessageContent> => {
	if (!message.buttons.length) {
		throw bad('buttons cannot be empty')
	}

	const { ButtonsMessage } = proto.Message
	const buttonsMessage: proto.Message.IButtonsMessage = {
		buttons: message.buttons.map(button => {
			const b = button as any
			if (has(b, 'sections')) {
				return {
					type: ButtonsMessage.Button.Type.NATIVE_FLOW,
					nativeFlowInfo: {
						name: 'single_select',
						paramsJson: JSON.stringify({ title: b.text, sections: normalizeSections(b.sections) })
					}
				}
			}

			if (has(b, 'name')) {
				return {
					type: ButtonsMessage.Button.Type.NATIVE_FLOW,
					nativeFlowInfo: { name: b.name, paramsJson: b.paramsJson }
				}
			}

			if (!has(b, 'id') || !has(b, 'text')) {
				throw bad('Each button needs id and text')
			}

			return {
				buttonId: String(b.id),
				buttonText: { displayText: String(b.text) },
				type: ButtonsMessage.Button.Type.RESPONSE
			}
		}),
		contentText: bodyText(message),
		headerType: ButtonsMessage.HeaderType.EMPTY
	}

	const media = pickHeaderMedia(message, true)
	if (media) {
		const prepared = await prepareMedia(media, options)
		if (prepared.imageMessage) {
			buttonsMessage.imageMessage = prepared.imageMessage
			buttonsMessage.headerType = ButtonsMessage.HeaderType.IMAGE
		} else if (prepared.videoMessage) {
			buttonsMessage.videoMessage = prepared.videoMessage
			buttonsMessage.headerType = ButtonsMessage.HeaderType.VIDEO
		} else if (prepared.documentMessage) {
			buttonsMessage.documentMessage = prepared.documentMessage
			buttonsMessage.headerType = ButtonsMessage.HeaderType.DOCUMENT
		}
	}

	if (message.footer) {
		buttonsMessage.footerText = message.footer
	}

	return { buttonsMessage }
}

const buildListMessage = (message: ListMessageContent): WAMessageContent => {
	if (!message.sections.length) {
		throw bad('sections cannot be empty')
	}

	if (!message.buttonText) {
		throw bad('buttonText is required for a list message')
	}

	return {
		listMessage: {
			title: message.title,
			description: message.text ?? '',
			buttonText: message.buttonText,
			footerText: message.footer,
			listType: proto.Message.ListMessage.ListType.SINGLE_SELECT,
			sections: message.sections.map(section => ({
				title: section.title || '',
				rows: (section.rows || []).map(row => ({
					title: row.title,
					description: row.description,
					rowId: row.rowId ?? row.id ?? row.title
				}))
			}))
		}
	}
}

const buildHeader = async (
	source: { title?: string; subtitle?: string },
	media: any,
	options: MessageContentGenerationOptions,
	prepareMedia: MediaPreparer
): Promise<proto.Message.InteractiveMessage.IHeader | undefined> => {
	if (!media) {
		if (!source.title && !source.subtitle) {
			return undefined
		}

		return { title: source.title || '', subtitle: source.subtitle || '', hasMediaAttachment: false }
	}

	const prepared = await prepareMedia(media, options)
	const header: proto.Message.InteractiveMessage.IHeader = {
		title: source.title || '',
		subtitle: source.subtitle || '',
		hasMediaAttachment: true
	}
	if (prepared.imageMessage) {
		header.imageMessage = prepared.imageMessage
	} else if (prepared.videoMessage) {
		header.videoMessage = prepared.videoMessage
	} else if (prepared.documentMessage) {
		header.documentMessage = prepared.documentMessage
	} else {
		throw bad('Invalid media type for interactive header')
	}

	return header
}

const buildNativeFlowMessage = async (
	message: NativeFlowMessageContent,
	options: MessageContentGenerationOptions,
	prepareMedia: MediaPreparer
): Promise<WAMessageContent> => {
	const interactiveMessage: proto.Message.IInteractiveMessage = {
		body: { text: bodyText(message) },
		nativeFlowMessage: prepareNativeFlowButtons(message.nativeFlow)
	}
	const header = await buildHeader(message, pickHeaderMedia(message, true), options, prepareMedia)
	if (header) {
		interactiveMessage.header = header
	}

	if (message.footer) {
		interactiveMessage.footer = { text: message.footer }
	}

	return { interactiveMessage }
}

const buildCarouselMessage = async (
	message: CarouselMessageContent,
	options: MessageContentGenerationOptions,
	prepareMedia: MediaPreparer
): Promise<WAMessageContent> => {
	if (!message.cards.length) {
		throw bad('cards cannot be empty')
	}

	const cards = await Promise.all(
		message.cards.map(async (card: CarouselCard, index) => {
			const media = pickHeaderMedia(card, false)
			if (!media) {
				throw bad(`Carousel card ${index + 1} needs an image or a video`)
			}

			const built: proto.Message.IInteractiveMessage = {
				header: await buildHeader(card, media, options, prepareMedia),
				body: { text: card.caption ?? '' },
				nativeFlowMessage: prepareNativeFlowButtons(card.nativeFlow || [])
			}
			if (card.footer) {
				built.footer = { text: card.footer }
			}

			return built
		})
	)

	const interactiveMessage: proto.Message.IInteractiveMessage = {
		body: { text: message.text ?? '' },
		carouselMessage: { cards, messageVersion: 1 }
	}
	if (message.footer) {
		interactiveMessage.footer = { text: message.footer }
	}

	return { interactiveMessage }
}

/**
 * Build the WhatsApp message for buttons / list / native flow / carousel content.
 * `prepareMedia` is injected so this file does not import the media pipeline directly.
 */
export const generateInteractiveContent = async (
	message: any,
	options: MessageContentGenerationOptions,
	prepareMedia: MediaPreparer
): Promise<WAMessageContent> => {
	if (has(message, 'cards')) {
		return buildCarouselMessage(message, options, prepareMedia)
	}

	if (has(message, 'nativeFlow')) {
		return buildNativeFlowMessage(message, options, prepareMedia)
	}

	if (has(message, 'buttons')) {
		return buildButtonsMessage(message, options, prepareMedia)
	}

	return buildListMessage(message)
}

/** Interactive messages are only rendered by WhatsApp when the stanza carries a `biz` node */
export const shouldIncludeBizBinaryNode = (message: proto.IMessage | null | undefined): boolean =>
	!!(
		message?.buttonsMessage ||
		message?.listMessage ||
		message?.templateMessage ||
		message?.interactiveMessage?.nativeFlowMessage ||
		message?.interactiveMessage?.carouselMessage
	)
