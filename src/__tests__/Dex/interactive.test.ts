import { proto } from '../../../WAProto/index.js'
import {
	generateInteractiveContent,
	generateWAMessageContent,
	hasInteractiveContent,
	prepareNativeFlowButtons,
	shouldIncludeBizBinaryNode
} from '../../Utils'
import { getBinaryNodeChild, getBizBinaryNode } from '../../WABinary'

const fakeMedia = async (media: any) => {
	if (media.image) return { imageMessage: { url: 'https://example.invalid/i', mimetype: 'image/jpeg' } }
	if (media.video) return { videoMessage: { url: 'https://example.invalid/v', mimetype: 'video/mp4' } }
	return { documentMessage: { url: 'https://example.invalid/d', mimetype: media.mimetype, fileName: media.fileName } }
}

const opts: any = { upload: async () => ({}) }
const roundTrip = (m: proto.IMessage) => proto.Message.decode(proto.Message.encode(proto.Message.create(m)).finish())

describe('interactive content', () => {
	it('detects interactive shapes only', () => {
		expect(hasInteractiveContent({ text: 'hi' })).toBe(false)
		expect(hasInteractiveContent({ image: Buffer.alloc(1) })).toBe(false)
		expect(hasInteractiveContent({ text: 'hi', buttons: [] })).toBe(true)
		expect(hasInteractiveContent({ sections: [], buttonText: 'x' })).toBe(true)
		expect(hasInteractiveContent({ nativeFlow: [] })).toBe(true)
		expect(hasInteractiveContent({ cards: [] })).toBe(true)
		expect(hasInteractiveContent(null)).toBe(false)
	})

	it('builds classic reply buttons', async () => {
		const m = await generateInteractiveContent(
			{ text: 'Pick', footer: 'DexBaileys', buttons: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }] },
			opts,
			fakeMedia
		)
		const decoded = roundTrip(m).buttonsMessage!
		expect(decoded.contentText).toBe('Pick')
		expect(decoded.footerText).toBe('DexBaileys')
		expect(decoded.headerType).toBe(proto.Message.ButtonsMessage.HeaderType.EMPTY)
		expect(decoded.buttons!.map(b => [b.buttonId, b.buttonText!.displayText, b.type])).toEqual([
			['a', 'A', proto.Message.ButtonsMessage.Button.Type.RESPONSE],
			['b', 'B', proto.Message.ButtonsMessage.Button.Type.RESPONSE]
		])
	})

	it('puts an image header on reply buttons', async () => {
		const m = await generateInteractiveContent(
			{ image: Buffer.alloc(4), caption: 'Cap', buttons: [{ id: 'a', text: 'A' }] },
			opts,
			fakeMedia
		)
		expect(m.buttonsMessage!.headerType).toBe(proto.Message.ButtonsMessage.HeaderType.IMAGE)
		expect(m.buttonsMessage!.imageMessage!.mimetype).toBe('image/jpeg')
		expect(m.buttonsMessage!.contentText).toBe('Cap')
	})

	it('rejects bad buttons', async () => {
		await expect(generateInteractiveContent({ text: 'x', buttons: [] }, opts, fakeMedia)).rejects.toThrow(/empty/)
		await expect(generateInteractiveContent({ text: 'x', buttons: [{ text: 'no id' }] }, opts, fakeMedia)).rejects.toThrow(
			/id and text/
		)
		await expect(
			generateInteractiveContent(
				{ image: Buffer.alloc(1), video: Buffer.alloc(1), buttons: [{ id: 'a', text: 'A' }] },
				opts,
				fakeMedia
			)
		).rejects.toThrow(/only one/)
	})

	it('builds a list message', async () => {
		const m = await generateInteractiveContent(
			{
				text: 'Menu',
				title: 'T',
				buttonText: 'Open',
				sections: [{ title: 'S1', rows: [{ title: 'Row', id: 'r1', description: 'd' }, { title: 'NoId' }] }]
			},
			opts,
			fakeMedia
		)
		const list = roundTrip(m).listMessage!
		expect(list.buttonText).toBe('Open')
		expect(list.description).toBe('Menu')
		expect(list.listType).toBe(proto.Message.ListMessage.ListType.SINGLE_SELECT)
		expect(list.sections![0]!.rows!.map(r => r.rowId)).toEqual(['r1', 'NoId'])
		await expect(generateInteractiveContent({ text: 'x', sections: [{ rows: [] }] }, opts, fakeMedia)).rejects.toThrow(
			/buttonText/
		)
	})

	it('maps every native flow button kind', () => {
		const flow = prepareNativeFlowButtons([
			{ text: 'Reply', id: 'r' },
			{ text: 'Site', url: 'https://example.invalid' },
			{ text: 'Copy', copy: 'CODE' },
			{ text: 'Call', call: '+911234567890' },
			{ text: 'List', sections: [{ title: 'S', rows: [{ title: 'One', id: '1' }] }] },
			{ name: 'cta_reminder', buttonParamsJson: '{"x":1}' }
		])
		expect(flow.buttons!.map(b => b.name)).toEqual([
			'quick_reply',
			'cta_url',
			'cta_copy',
			'cta_call',
			'single_select',
			'cta_reminder'
		])
		expect(JSON.parse(flow.buttons![0]!.buttonParamsJson!)).toEqual({ display_text: 'Reply', id: 'r' })
		expect(JSON.parse(flow.buttons![1]!.buttonParamsJson!).url).toBe('https://example.invalid')
		expect(JSON.parse(flow.buttons![2]!.buttonParamsJson!).copy_code).toBe('CODE')
		expect(JSON.parse(flow.buttons![3]!.buttonParamsJson!).phone_number).toBe('+911234567890')
		expect(JSON.parse(flow.buttons![4]!.buttonParamsJson!).sections[0].rows[0].id).toBe('1')
		expect(flow.buttons![5]!.buttonParamsJson).toBe('{"x":1}')
		expect(() => prepareNativeFlowButtons([{ text: 'nothing' } as any])).toThrow(/Invalid nativeFlow button/)
	})

	it('builds a native flow message with and without media', async () => {
		const plain = await generateInteractiveContent(
			{ text: 'Body', footer: 'F', nativeFlow: [{ text: 'Go', id: 'go' }] },
			opts,
			fakeMedia
		)
		expect(plain.interactiveMessage!.body!.text).toBe('Body')
		expect(plain.interactiveMessage!.header).toBeUndefined()
		expect(plain.interactiveMessage!.footer!.text).toBe('F')

		const media = await generateInteractiveContent(
			{ video: Buffer.alloc(1), caption: 'C', title: 'T', nativeFlow: [{ text: 'Go', id: 'go' }] },
			opts,
			fakeMedia
		)
		const im = roundTrip(media).interactiveMessage!
		expect(im.header!.hasMediaAttachment).toBe(true)
		expect(im.header!.title).toBe('T')
		expect(im.header!.videoMessage!.mimetype).toBe('video/mp4')
		expect(im.body!.text).toBe('C')
		expect(im.nativeFlowMessage!.buttons).toHaveLength(1)
	})

	it('builds a carousel and insists on card media', async () => {
		const m = await generateInteractiveContent(
			{
				text: 'Swipe',
				cards: [
					{ image: Buffer.alloc(1), title: 'One', caption: 'c1', nativeFlow: [{ text: 'A', id: 'a' }] },
					{ video: Buffer.alloc(1), caption: 'c2', footer: 'f2' }
				]
			},
			opts,
			fakeMedia
		)
		const carousel = roundTrip(m).interactiveMessage!.carouselMessage!
		expect(carousel.cards).toHaveLength(2)
		expect(carousel.cards![0]!.header!.imageMessage).toBeTruthy()
		expect(carousel.cards![0]!.nativeFlowMessage!.buttons).toHaveLength(1)
		expect(carousel.cards![1]!.header!.videoMessage).toBeTruthy()
		expect(carousel.cards![1]!.footer!.text).toBe('f2')
		expect(roundTrip(m).interactiveMessage!.body!.text).toBe('Swipe')
		await expect(generateInteractiveContent({ cards: [{ caption: 'no media' }] }, opts, fakeMedia)).rejects.toThrow(
			/card 1 needs/
		)
	})

	it('goes through generateWAMessageContent with mentions and viewOnce', async () => {
		const m = await generateWAMessageContent(
			{ text: 'Hi @x', mentions: ['911@s.whatsapp.net'], nativeFlow: [{ text: 'Ok', id: 'ok' }] },
			opts
		)
		expect(m.interactiveMessage!.contextInfo!.mentionedJid).toEqual(['911@s.whatsapp.net'])

		const plainText = await generateWAMessageContent({ text: 'just text' }, opts)
		expect(plainText.extendedTextMessage?.text ?? plainText.conversation).toBe('just text')
		expect(plainText.interactiveMessage).toBeFalsy()
	})
})

describe('biz node', () => {
	it('is needed only for interactive messages', () => {
		expect(shouldIncludeBizBinaryNode({ conversation: 'hi' })).toBe(false)
		expect(shouldIncludeBizBinaryNode({ imageMessage: {} })).toBe(false)
		expect(shouldIncludeBizBinaryNode(undefined)).toBe(false)
		expect(shouldIncludeBizBinaryNode({ buttonsMessage: {} })).toBe(true)
		expect(shouldIncludeBizBinaryNode({ listMessage: {} })).toBe(true)
		expect(shouldIncludeBizBinaryNode({ interactiveMessage: { nativeFlowMessage: {} } })).toBe(true)
		expect(shouldIncludeBizBinaryNode({ interactiveMessage: { carouselMessage: {} } })).toBe(true)
		expect(shouldIncludeBizBinaryNode({ interactiveMessage: { body: { text: 'x' } } })).toBe(false)
	})

	it('uses the mixed native flow node for buttons and the list node for lists', () => {
		const forButtons = getBizBinaryNode({ buttonsMessage: {} })
		expect(forButtons.tag).toBe('biz')
		const interactive = getBinaryNodeChild(forButtons, 'interactive')!
		expect(interactive.attrs).toEqual({ type: 'native_flow', v: '1' })
		expect(getBinaryNodeChild(interactive, 'native_flow')!.attrs).toEqual({ v: '9', name: 'mixed' })
		expect(getBinaryNodeChild(forButtons, 'quality_control')!.attrs.decision_id).toMatch(/^[0-9a-f]{40}$/)

		const forList = getBizBinaryNode({ listMessage: {} })
		expect(getBinaryNodeChild(forList, 'list')!.attrs).toEqual({ v: '2', type: 'product_list' })
		expect(getBinaryNodeChild(forList, 'interactive')).toBeUndefined()

		const special = getBizBinaryNode({
			interactiveMessage: { nativeFlowMessage: { buttons: [{ name: 'send_location', buttonParamsJson: '{}' }] } }
		})
		expect(getBinaryNodeChild(getBinaryNodeChild(special, 'interactive'), 'native_flow')!.attrs).toEqual({
			v: '2',
			name: 'send_location'
		})
	})

	it('gives every message its own decision id', () => {
		const a = getBinaryNodeChild(getBizBinaryNode({ buttonsMessage: {} }), 'quality_control')!.attrs.decision_id
		const b = getBinaryNodeChild(getBizBinaryNode({ buttonsMessage: {} }), 'quality_control')!.attrs.decision_id
		expect(a).not.toBe(b)
	})
})
