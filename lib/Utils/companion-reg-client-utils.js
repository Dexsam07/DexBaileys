import { randomBytes } from 'crypto';
import { getBinaryNodeChild } from '../WABinary/index.js';
export var CompanionWebClientType;
(function (CompanionWebClientType) {
    CompanionWebClientType[CompanionWebClientType["UNKNOWN"] = 0] = "UNKNOWN";
    CompanionWebClientType[CompanionWebClientType["CHROME"] = 1] = "CHROME";
    CompanionWebClientType[CompanionWebClientType["EDGE"] = 2] = "EDGE";
    CompanionWebClientType[CompanionWebClientType["FIREFOX"] = 3] = "FIREFOX";
    CompanionWebClientType[CompanionWebClientType["IE"] = 4] = "IE";
    CompanionWebClientType[CompanionWebClientType["OPERA"] = 5] = "OPERA";
    CompanionWebClientType[CompanionWebClientType["SAFARI"] = 6] = "SAFARI";
    CompanionWebClientType[CompanionWebClientType["ELECTRON"] = 7] = "ELECTRON";
    CompanionWebClientType[CompanionWebClientType["UWP"] = 8] = "UWP";
    CompanionWebClientType[CompanionWebClientType["OTHER_WEB_CLIENT"] = 9] = "OTHER_WEB_CLIENT";
})(CompanionWebClientType || (CompanionWebClientType = {}));
const BROWSER_TO_COMPANION_WEB_CLIENT = {
    Chrome: CompanionWebClientType.CHROME,
    Edge: CompanionWebClientType.EDGE,
    Firefox: CompanionWebClientType.FIREFOX,
    IE: CompanionWebClientType.IE,
    Opera: CompanionWebClientType.OPERA,
    Safari: CompanionWebClientType.SAFARI
};
export const getCompanionWebClientType = ([os, browserName]) => {
    if (browserName === 'Desktop') {
        return os === 'Windows' ? CompanionWebClientType.UWP : CompanionWebClientType.ELECTRON;
    }
    return BROWSER_TO_COMPANION_WEB_CLIENT[browserName] || CompanionWebClientType.OTHER_WEB_CLIENT;
};
export const getCompanionPlatformId = (browser) => {
    return getCompanionWebClientType(browser).toString();
};
export const buildPairingQRData = (ref, noiseKeyB64, identityKeyB64, advB64, browser) => {
    return ('https://wa.me/settings/linked_devices#' +
        [ref, noiseKeyB64, identityKeyB64, advB64, getCompanionPlatformId(browser)].join(','));
};
/** The two children WhatsApp Web accepts on a companion_reg_refresh notification */
const COMPANION_REG_REFRESH_CHILDREN = ['companion_reg_refresh', 'pair-device-rotate-qr'];
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
export const handleCompanionRegRefresh = (node, { creds, emitCredsUpdate, refreshQR, logger }) => {
    const hasExpectedChild = COMPANION_REG_REFRESH_CHILDREN.some(tag => !!getBinaryNodeChild(node, tag));
    if (!hasExpectedChild) {
        logger?.warn({ id: node?.attrs?.id }, 'companion_reg_refresh without an expected child; ignoring');
        return 'ignored_malformed';
    }
    if (creds.me) {
        logger?.debug({ id: node?.attrs?.id }, 'companion_reg_refresh on a registered session; keeping the adv secret');
        return 'ignored_registered';
    }
    creds.advSecretKey = randomBytes(32).toString('base64');
    emitCredsUpdate?.({ advSecretKey: creds.advSecretKey });
    logger?.info({ id: node?.attrs?.id }, 'rotated the adv secret; re-rendering the pairing QR');
    refreshQR?.();
    return 'rotated';
};
/**
 * Clean a user-supplied phone number for the pairing-code flow.
 * "+91 73842-87404", "0091…" and "917384287404" all become the same digits.
 * Returns undefined when the result cannot be a valid international number.
 */
export const normalizePairingPhoneNumber = (input, { defaultCountryCode } = {}) => {
    if (typeof input !== 'string' && typeof input !== 'number') {
        return undefined;
    }
    let digits = String(input).replace(/\D/g, '');
    if (!digits) {
        return undefined;
    }
    if (digits.startsWith('00')) {
        // international prefix written as 00 instead of +
        digits = digits.slice(2);
    }
    else if (digits.startsWith('0') && defaultCountryCode) {
        // national notation, for example 07384… with defaultCountryCode 91
        digits = `${defaultCountryCode.replace(/\D/g, '')}${digits.slice(1)}`;
    }
    // E.164: country code + subscriber number, 8 to 15 digits
    if (digits.length < 8 || digits.length > 15) {
        return undefined;
    }
    return digits;
};
//# sourceMappingURL=companion-reg-client-utils.js.map