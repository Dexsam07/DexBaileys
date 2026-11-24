import { proto } from '../../WAProto/index.js';
import type { MessageContentGenerationOptions, NativeFlowButton, WAMessageContent } from '../Types/index.js';
type MediaPreparer = (media: any, options: MessageContentGenerationOptions) => Promise<WAMessageContent>;
/** True when the content asks for buttons, a list, native flow buttons or a carousel */
export declare const hasInteractiveContent: (message: unknown) => boolean;
/** Convert the friendly button shapes into WhatsApp native flow buttons */
export declare const prepareNativeFlowButtons: (buttons?: NativeFlowButton[]) => proto.Message.InteractiveMessage.INativeFlowMessage;
/**
 * Build the WhatsApp message for buttons / list / native flow / carousel content.
 * `prepareMedia` is injected so this file does not import the media pipeline directly.
 */
export declare const generateInteractiveContent: (message: any, options: MessageContentGenerationOptions, prepareMedia: MediaPreparer) => Promise<WAMessageContent>;
/** Interactive messages are only rendered by WhatsApp when the stanza carries a `biz` node */
export declare const shouldIncludeBizBinaryNode: (message: proto.IMessage | null | undefined) => boolean;
export {};
//# sourceMappingURL=interactive.d.ts.map