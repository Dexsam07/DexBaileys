import type { AuthenticationCreds, WABrowserDescription } from '../Types/index.js';
import { type BinaryNode } from '../WABinary/index.js';
import type { ILogger } from './logger.js';
export declare enum CompanionWebClientType {
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
export declare const getCompanionWebClientType: ([os, browserName]: WABrowserDescription) => CompanionWebClientType;
export declare const getCompanionPlatformId: (browser: WABrowserDescription) => string;
export declare const buildPairingQRData: (ref: string, noiseKeyB64: string, identityKeyB64: string, advB64: string, browser: WABrowserDescription) => string;
export type CompanionRegRefreshResult = 'rotated' | 'ignored_malformed' | 'ignored_registered';
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
export declare const handleCompanionRegRefresh: (node: BinaryNode, { creds, emitCredsUpdate, refreshQR, logger }: {
    creds: Pick<AuthenticationCreds, "me" | "advSecretKey">;
    emitCredsUpdate?: (update: Partial<AuthenticationCreds>) => void;
    refreshQR?: () => void;
    logger?: ILogger;
}) => CompanionRegRefreshResult;
/**
 * Clean a user-supplied phone number for the pairing-code flow.
 * "+91 73842-87404", "0091…" and "917384287404" all become the same digits.
 * Returns undefined when the result cannot be a valid international number.
 */
export declare const normalizePairingPhoneNumber: (input: string | number, { defaultCountryCode }?: {
    defaultCountryCode?: string;
}) => string | undefined;
//# sourceMappingURL=companion-reg-client-utils.d.ts.map