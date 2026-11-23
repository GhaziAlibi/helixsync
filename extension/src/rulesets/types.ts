// Ruleset plaintext (docs/protocol.md §17). Encrypted with the account key
// before it leaves the browser; the server sees only the envelope. The same
// shapes are in web/src/rulesets/types.ts, which writes them.

export type Rule =
  | { id: string; kind: "excludeFolder"; folderId: string }
  | { id: string; kind: "includeFolder"; folderId: string }
  | { id: string; kind: "blockDomain"; domain: string }
  | { id: string; kind: "blockPattern"; pattern: string }
  | { id: string; kind: "blockLocal" };

export type RuleKind = Rule["kind"];

export interface RulesetPlaintext {
  v: 1;
  name: string;
  rules: Rule[];
}

/** Limits shared with the extension and the server (docs/protocol.md §17). */
export const MAX_RULES = 500;
export const MAX_PATTERN_RULES = 20;
export const MAX_PATTERN_LENGTH = 200;
export const MAX_NAME_LENGTH = 100;
/** The server refuses an envelope larger than this many bytes of JSON. */
export const MAX_ENVELOPE_BYTES = 64 * 1024;
