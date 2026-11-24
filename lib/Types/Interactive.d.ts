import type { proto } from '../../WAProto/index.js';
import type { WAMediaUpload } from './Message.js';
/** One row inside a list / single_select section */
export type InteractiveListRow = {
    title: string;
    id?: string;
    rowId?: string;
    description?: string;
    header?: string;
};
export type InteractiveListSection = {
    title?: string;
    rows: InteractiveListRow[];
};
/**
 * A button for `nativeFlow` messages and carousel cards.
 * The shape decides the button kind:
 *  - `{ text, id }`        quick reply
 *  - `{ text, url }`       open link
 *  - `{ text, copy }`      copy code
 *  - `{ text, call }`      call a phone number
 *  - `{ text, sections }`  single-select list
 *  - `{ name, buttonParamsJson }` raw native flow button (advanced)
 */
export type NativeFlowButton = {
    text?: string;
    id: string;
    icon?: string;
} | {
    text?: string;
    url: string;
    useWebview?: boolean;
    icon?: string;
} | {
    text?: string;
    copy: string;
    icon?: string;
} | {
    text?: string;
    call: string;
    icon?: string;
} | {
    text?: string;
    sections: InteractiveListSection[];
    icon?: string;
} | {
    name: string;
    buttonParamsJson: string;
};
/** A classic reply button, or a single-select list when `sections` is given */
export type SimpleButton = {
    id: string;
    text: string;
} | {
    text: string;
    sections: InteractiveListSection[];
} | {
    name: string;
    paramsJson: string;
};
/** Optional media shown above the text. Give only one. */
export type InteractiveHeaderMedia = {
    image?: WAMediaUpload;
    video?: WAMediaUpload;
    document?: WAMediaUpload;
    mimetype?: string;
    fileName?: string;
    /** body text when a media header is used */
    caption?: string;
};
type InteractiveCommon = {
    /** body text (use `caption` instead when sending media) */
    text?: string;
    footer?: string;
    mentions?: string[];
    mentionAll?: boolean;
    contextInfo?: proto.IContextInfo;
};
/** Classic reply buttons (max 3 is what WhatsApp renders) */
export type ButtonsMessageContent = InteractiveCommon & InteractiveHeaderMedia & {
    buttons: SimpleButton[];
};
/** Classic list message */
export type ListMessageContent = InteractiveCommon & {
    sections: InteractiveListSection[];
    /** label of the button that opens the list */
    buttonText: string;
    title?: string;
};
/** Modern interactive message: quick reply, URL, copy, call, list */
export type NativeFlowMessageContent = InteractiveCommon & InteractiveHeaderMedia & {
    nativeFlow: NativeFlowButton[];
    title?: string;
    subtitle?: string;
};
export type CarouselCard = {
    image?: WAMediaUpload;
    video?: WAMediaUpload;
    title?: string;
    subtitle?: string;
    /** card body text */
    caption?: string;
    footer?: string;
    nativeFlow?: NativeFlowButton[];
};
/** Swipeable cards; every card needs an image or a video */
export type CarouselMessageContent = InteractiveCommon & {
    cards: CarouselCard[];
};
export type InteractiveMessageContent = ButtonsMessageContent | ListMessageContent | NativeFlowMessageContent | CarouselMessageContent;
export {};
//# sourceMappingURL=Interactive.d.ts.map