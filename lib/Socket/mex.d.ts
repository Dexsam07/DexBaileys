import type { NewsletterMetadata } from '../Types/index.js';
import { type BinaryNode } from '../WABinary/index.js';
/** Tolerant WMex JSON reader: handles UTF-8/Latin-1 bytes and leading binary noise. */
export declare const parseWMexJson: (content: BinaryNode["content"]) => Record<string, unknown> | null;
export declare const extractNewsletterJidFromBinaryNode: (node: BinaryNode | undefined) => string | null;
/**
 * Best-effort decoder for structured newsletter metadata in a BinaryNode tree.
 * It extracts tagged/attributed fields and embedded JSON. Opaque binary formats
 * without field boundaries cannot be safely guessed.
 */
export declare const extractNewsletterMetadataFromBinaryNode: (node: BinaryNode | undefined) => (Partial<NewsletterMetadata> & Pick<NewsletterMetadata, "id">) | null;
export declare const executeWMexQuery: <T>(variables: Record<string, unknown>, queryId: string, dataPath: string, query: (node: BinaryNode) => Promise<BinaryNode>, generateMessageTag: () => string) => Promise<T>;
//# sourceMappingURL=mex.d.ts.map