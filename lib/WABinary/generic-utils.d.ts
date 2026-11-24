import { proto } from '../../WAProto/index.js';
import { type BinaryNode } from './types.js';
export declare const getBinaryNodeChildren: (node: BinaryNode | undefined, childTag: string) => BinaryNode[];
export declare const getBinaryNodeChild: (node: BinaryNode | undefined, childTag: string) => BinaryNode | undefined;
export declare const getAllBinaryNodeChildren: ({ content }: BinaryNode) => BinaryNode[];
export declare const getBinaryNodeChildBuffer: (node: BinaryNode | undefined, childTag: string) => Uint8Array<ArrayBufferLike> | Buffer<ArrayBufferLike> | undefined;
export declare const getBinaryNodeChildString: (node: BinaryNode | undefined, childTag: string) => string | undefined;
export declare const getBinaryNodeChildUInt: (node: BinaryNode, childTag: string, length: number) => number | undefined;
export declare const assertNodeErrorFree: (node: BinaryNode) => void;
export declare const reduceBinaryNodeToDictionary: (node: BinaryNode, tag: string) => {
    [_: string]: string;
};
export declare const getBinaryNodeMessages: ({ content }: BinaryNode) => proto.WebMessageInfo[];
export declare function binaryNodeToString(node: BinaryNode | BinaryNode['content'], i?: number): string;
/**
 * The `biz` child node WhatsApp expects on a message stanza that carries
 * buttons, a list or native flow buttons. Without it the receiving client
 * drops the interactive part of the message.
 */
export declare const getBizBinaryNode: (message: proto.IMessage) => BinaryNode;
//# sourceMappingURL=generic-utils.d.ts.map