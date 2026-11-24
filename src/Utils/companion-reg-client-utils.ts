import { randomBytes } from 'crypto'
import type { AuthenticationCreds, WABrowserDescription } from '../Types'
import { type BinaryNode, getBinaryNodeChild } from '../WABinary'
import type { ILogger } from './logger'

export enum CompanionWebClientType {
	UNKNOWN = 0,
	CHROME = 1,
	EDGE = 2,
	FIREFOX = 3,
	IE = 4,
	OPERA = 5,
	SAFARI = 6,
	ELECTRON = 7,
	UWP = 8,
	OTHER_WEB_CLIENT = 9
}

const BROWSER_TO_COMPANION_WEB_CLIENT: Record<string, CompanionWebClientType> = {
	Chrome: CompanionWebClientType.CHROME,
	Edge: CompanionWebClientType.EDGE,
	Firefox: CompanionWebClientType.FIREFOX,
	IE: CompanionWebClientType.IE,
	Opera: CompanionWebClientType.OPERA,
	Safari: CompanionWebClientType.SAFARI
}

export const getCompanionWebClientType = ([os, browserName]: WABrowserDescription): CompanionWebClientType => {
	if (browserName === 'Desktop') {
		return os === 'Windows' ? CompanionWebClientType.UWP : CompanionWebClientType.ELECTRON
	}

	return BROWSER_TO_COMPANION_WEB_CLIENT[browserName] || CompanionWebClientType.OTHER_WEB_CLIENT
}

export const getCompanionPlatformId = (browser: WABrowserDescription): string => {
	return getCompanionWebClientType(browser).toString()
}

export const buildPairingQRData = (
	ref: string,
	noiseKeyB64: string,
	identityKeyB64: string,
	advB64: string,
	browser: WABrowserDescription
): string => {
	return (
		'https://wa.me/settings/linked_devices#' +
		[ref, noiseKeyB64, identityKeyB64, advB64, getCompanionPlatformId(browser)].join(',')
	)
}

/** The two children WhatsApp Web accepts on a companion_reg_refresh notification */
const COMPANION_REG_REFRESH_CHILDREN = ['companion_reg_refresh', 'pair-device-rotate-qr']

export type CompanionRegRefreshResult = 'rotated' | 'ignored_malformed' | 'ignored_registered'

/**
 * `<notification type="companion_reg_refresh">`: the server retires the
 * registration material of a companion that has not paired yet. The adv
 * secret is part of the pairing QR, so it has to be rotated and the QR
 * re-rendered; otherwise the phone scans a QR built on a retired secret and
 * linking fails (WhiskeySockets/Baileys#2737).
 *
 * A session that already has `creds.me` keeps its secret: a completed or
 * pending pairing is verified against it.
 */
export const handleCompanionRegRefresh = (
	node: BinaryNode,
	{
		creds,
		emitCredsUpdate,
		refreshQR,
		logger
	}: {
		creds: Pick<AuthenticationCreds, 'me' | 'advSecretKey'>
		emitCredsUpdate?: (update: Partial<AuthenticationCreds>) => void
		refreshQR?: () => void
		logger?: ILogger
	}
): CompanionRegRefreshResult => {
	const hasExpectedChild = COMPANION_REG_REFRESH_CHILDREN.some(tag => !!getBinaryNodeChild(node, tag))
	if (!hasExpectedChild) {
		logger?.warn({ id: node?.attrs?.id }, 'companion_reg_refresh without an expected child; ignoring')
		return 'ignored_malformed'
	}

	if (creds.me) {
		logger?.debug({ id: node?.attrs?.id }, 'companion_reg_refresh on a registered session; keeping the adv secret')
		return 'ignored_registered'
	}

	creds.advSecretKey = randomBytes(32).toString('base64')
	emitCredsUpdate?.({ advSecretKey: creds.advSecretKey })
	logger?.info({ id: node?.attrs?.id }, 'rotated the adv secret; re-rendering the pairing QR')
	refreshQR?.()
	return 'rotated'
}

/**
 * Clean a user-supplied phone number for the pairing-code flow.
 * "+91 73842-87404", "0091…" and "917384287404" all become the same digits.
 * Returns undefined when the result cannot be a valid international number.
 */
export const normalizePairingPhoneNumber = (
	input: string | number,
	{ defaultCountryCode }: { defaultCountryCode?: string } = {}
): string | undefined => {
	if (typeof input !== 'string' && typeof input !== 'number') {
		return undefined
	}

	let digits = String(input).replace(/\D/g, '')
	if (!digits) {
		return undefined
	}

	if (digits.startsWith('00')) {
		// international prefix written as 00 instead of +
		digits = digits.slice(2)
	} else if (digits.startsWith('0') && defaultCountryCode) {
		// national notation, for example 07384… with defaultCountryCode 91
		digits = `${defaultCountryCode.replace(/\D/g, '')}${digits.slice(1)}`
	}

	// E.164: country code + subscriber number, 8 to 15 digits
	if (digits.length < 8 || digits.length > 15) {
		return undefined
	}

	return digits
}
