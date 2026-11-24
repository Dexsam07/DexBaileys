import type { ILogger } from './logger.js';
/** Codes that mean "this session will never work again: stop and pair again" */
export declare const FATAL_DISCONNECT_CODES: ReadonlySet<number>;
/** Codes that can be caused by an outdated WhatsApp Web version */
export declare const STALE_VERSION_CODES: ReadonlySet<number>;
export type ReconnectContext = {
    /** 0 for the first connect, then 1, 2, 3… */
    attempt: number;
    /** status code of the disconnect that caused this connect, if any */
    statusCode?: number;
    /** version returned by `versionProvider`, when one was fetched */
    version?: [number, number, number];
};
type MinimalSocket = {
    ev: {
        on: (event: 'connection.update', listener: (update: any) => void) => void;
    };
};
export type ReconnectManagerOptions<S extends MinimalSocket> = {
    /** builds a new socket; called for the first connect and for every reconnect */
    connect: (context: ReconnectContext) => S | Promise<S>;
    /** runs for every socket the manager creates; attach your event handlers here */
    onSocket?: (socket: S, context: ReconnectContext) => void | Promise<void>;
    /** return false to stop reconnecting; default refuses logged out / forbidden / mismatch */
    shouldReconnect?: (statusCode: number | undefined, context: ReconnectContext) => boolean;
    /** called before a reconnect after a 408; its result is handed to `connect` */
    versionProvider?: () => Promise<[number, number, number] | undefined>;
    /** called once when the manager stops retrying */
    onGiveUp?: (statusCode: number | undefined, error: unknown) => void;
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    /** 0 to 1; share of the delay that is randomised so many bots do not reconnect together */
    jitter?: number;
    /** delay after 515 (restart required), which WhatsApp sends on purpose after pairing */
    restartRequiredDelayMs?: number;
    logger?: ILogger;
};
export declare const shouldReconnectByDefault: (statusCode: number | undefined) => boolean;
/** Exponential backoff with jitter: about 1s, 2s, 4s… capped at maxDelayMs */
export declare const computeBackoff: ({ attempt, baseDelayMs, maxDelayMs, jitter, random }: {
    attempt: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    jitter?: number;
    random?: () => number;
}) => number;
/**
 * Baileys does not reconnect for you. This manager owns only the reconnect
 * policy: backoff between attempts, no reconnect on a logged-out session,
 * never two sockets at once, and a fresh WhatsApp Web version after a 408.
 * You still build the socket yourself in `connect`.
 */
export declare const createReconnectManager: <S extends MinimalSocket>({ connect, onSocket, shouldReconnect, versionProvider, onGiveUp, maxRetries, baseDelayMs, maxDelayMs, jitter, restartRequiredDelayMs, logger }: ReconnectManagerOptions<S>) => {
    /** connect for the first time */
    start: () => Promise<S | undefined>;
    /** stop reconnecting; the current socket is left for you to close */
    stop: () => void;
    readonly socket: S | undefined;
    readonly attempt: number;
};
export {};
//# sourceMappingURL=reconnect-manager.d.ts.map