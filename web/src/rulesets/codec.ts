// Encrypting and decrypting a ruleset (docs/encryption.md §6.5).
import {
  assertSupportedEnvelopeVersion,
  buildRulesetAad,
  decryptWithSdek,
  encryptWithSdek,
  getSdek,
  type EncryptionEnvelope,
} from "../crypto";
import { MAX_ENVELOPE_BYTES, type Rule, type RulesetPlaintext } from "./types";

/** The envelope would exceed the size the server accepts. */
export class RulesetTooLargeError extends Error {
  constructor() {
    super("ruleset is too large");
    this.name = "RulesetTooLargeError";
  }
}

/** Encrypts `plaintext` as revision `revision` of ruleset `rulesetId`. The
 * AAD binds both, so the revision here must be the one the server will store:
 * `current + 1` for an update, 1 for a new ruleset. */
export async function encryptRuleset(
  accountKey: Uint8Array,
  keyVersion: number,
  rulesetId: string,
  revision: number,
  plaintext: RulesetPlaintext,
): Promise<EncryptionEnvelope> {
  const sdek = await getSdek(accountKey, keyVersion);
  const envelope = encryptWithSdek(plaintext, sdek, keyVersion, buildRulesetAad(rulesetId, revision));
  if (new TextEncoder().encode(JSON.stringify(envelope)).length > MAX_ENVELOPE_BYTES) {
    throw new RulesetTooLargeError();
  }
  return envelope;
}

const RULE_KINDS = new Set(["excludeFolder", "includeFolder", "blockDomain", "blockPattern", "blockLocal"]);

function isRule(value: unknown): value is Rule {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.kind !== "string" || !RULE_KINDS.has(r.kind)) return false;
  switch (r.kind) {
    case "excludeFolder":
    case "includeFolder":
      return typeof r.folderId === "string";
    case "blockDomain":
      return typeof r.domain === "string";
    case "blockPattern":
      return typeof r.pattern === "string";
    default:
      return true;
  }
}

/** Decrypts and checks a ruleset. Throws on authentication failure (a wrong
 * id or revision, a tampered envelope, a different account key) and on a
 * plaintext that isn't a version 1 ruleset. */
export async function decryptRuleset(
  accountKey: Uint8Array,
  rulesetId: string,
  revision: number,
  envelope: EncryptionEnvelope,
): Promise<RulesetPlaintext> {
  assertSupportedEnvelopeVersion(envelope);
  const sdek = await getSdek(accountKey, envelope.keyVersion);
  const value = decryptWithSdek(envelope, sdek, buildRulesetAad(rulesetId, revision)) as Partial<RulesetPlaintext> | null;
  if (!value || value.v !== 1 || typeof value.name !== "string" || !Array.isArray(value.rules)) {
    throw new Error("malformed ruleset");
  }
  return { v: 1, name: value.name, rules: value.rules.filter(isRule) };
}
