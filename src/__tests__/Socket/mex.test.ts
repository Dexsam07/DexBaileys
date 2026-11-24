import {
	executeWMexQuery,
	extractNewsletterJidFromBinaryNode,
	extractNewsletterMetadataFromBinaryNode,
	parseWMexJson
} from '../../Socket/mex'
import type { BinaryNode } from '../../WABinary'

describe('WMex newsletter metadata response handling', () => {
	it('extracts one newsletter JID from the compact binary metadata payload', () => {
		const result: BinaryNode = {
			tag: 'result',
			attrs: {},
			content: Buffer.from([0x04, 0xff, 0x01, ...Buffer.from('120363431765097100', 'ascii')])
		}

		expect(extractNewsletterJidFromBinaryNode(result)).toBe('120363431765097100@newsletter')
	})

	it('accepts an explicit newsletter JID in response attributes', () => {
		const result: BinaryNode = {
			tag: 'result',
			attrs: { jid: '120363431765097100@newsletter' }
		}

		expect(extractNewsletterJidFromBinaryNode(result)).toBe('120363431765097100@newsletter')
	})

	it('does not guess when a binary response contains multiple channel-like IDs', () => {
		const result: BinaryNode = {
			tag: 'result',
			attrs: {},
			content: Buffer.from('120363431765097100 120363431765097101', 'ascii')
		}

		expect(extractNewsletterJidFromBinaryNode(result)).toBeNull()
	})

	it('does not turn unrelated numeric IDs into newsletter JIDs', () => {
		const result: BinaryNode = {
			tag: 'result',
			attrs: {},
			content: Buffer.from('923001234567 12345', 'ascii')
		}

		expect(extractNewsletterJidFromBinaryNode(result)).toBeNull()
	})

	it('recovers metadata from a non-JSON response returned by the WMex query', async () => {
		const payload = Buffer.from([0x04, 0xff, 0x01, ...Buffer.from('120363431765097100', 'ascii')])
		const result: BinaryNode = {
			tag: 'iq',
			attrs: { type: 'result' },
			content: [{ tag: 'result', attrs: {}, content: payload }]
		}
		const metadata = await executeWMexQuery<{ id: string; name?: string }>(
			{ input: { key: 'invite-code', type: 'INVITE' } },
			'newsletter-metadata-test',
			'xwa2_newsletter_metadata',
			async () => result,
			() => 'test-tag'
		)

		expect(metadata).toEqual({ id: '120363431765097100@newsletter' })
	})

	it('extracts structured channel metadata from binary node fields', () => {
		const node: BinaryNode = {
			tag: 'result',
			attrs: { id: '120363431765097100@newsletter' },
			content: [
				{ tag: 'name', attrs: {}, content: 'DEX Channel' },
				{ tag: 'description', attrs: {}, content: 'Official channel description' },
				{ tag: 'subscribers_count', attrs: {}, content: '1250' },
				{ tag: 'picture', attrs: { direct_path: '/v/t62.7118-24/example', id: 'picture-1' } }
			]
		}
		expect(extractNewsletterMetadataFromBinaryNode(node)).toMatchObject({
			id: '120363431765097100@newsletter',
			name: 'DEX Channel',
			description: 'Official channel description',
			subscribers: 1250,
			picture: { directPath: '/v/t62.7118-24/example', id: 'picture-1' }
		})
	})

	it('parses JSON after a binary prefix and accepts array-wrapped objects', () => {
		expect(parseWMexJson(Buffer.from([0xff, 0x00, ...Buffer.from('{"data":{"ok":true}}')]))).toEqual({
			data: { ok: true }
		})
		expect(parseWMexJson(Buffer.from('[{"data":{"ok":true}}]'))).toEqual({ data: { ok: true } })
	})

	it('rejects malformed binary responses for unrelated WMex queries', async () => {
		const result: BinaryNode = {
			tag: 'iq',
			attrs: { type: 'result' },
			content: [{ tag: 'result', attrs: {}, content: Buffer.from([0x04, 0xff, 0x01]) }]
		}

		await expect(
			executeWMexQuery(
				{},
				'other-query',
				'xwa2_newsletter_view',
				async () => result,
				() => 'test-tag'
			)
		).rejects.toThrow(/expected a JSON WMex result/)
	})
})
