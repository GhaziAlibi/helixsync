// Selective sync (docs/protocol.md §17): the rulesets the account owner
// assigned to this device in the dashboard, fetched, verified, kept, and
// combined into the rules the rest of the extension enforces.
//
// Fetching is `fetch.ts`; this file is what the sync modules call.
import { buildRulesetAad, decryptWithSdek, getSdek, assertSupportedEnvelopeVersion } from "../crypto";
import type { EncryptionEnvelope } from "../crypto";
import { getDevice, getRulesetsRecord, type RulesetsRecord, type StoredRuleset } from "../storage/db";
import { NO_RULES, combineRulesets, type EffectiveRules } from "./effective";
import type { Rule, RulesetPlaintext } from "./types";

export type { EffectiveRules } from "./effective";
export {
  NO_RULES,
  foldersWidened,
  folderRulesOf,
  hasFolderRules,
  hasUrlRules,
  isFolderExcluded,
  isUrlBlocked,
  sameFolderRules,
} from "./effective";

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

/** Decrypts one ruleset and checks it was written for this id and revision
 * (the AAD binds both), so the server can neither swap rulesets between ids
 * nor serve an older revision as the current one. Throws on any failure.
 * Rules of a kind this version doesn't know are dropped, not fatal. */
export async function decryptRuleset(
  accountKey: string,
  rulesetId: string,
  revision: number,
  envelope: unknown,
): Promise<RulesetPlaintext> {
  assertSupportedEnvelopeVersion(envelope);
  const env = envelope as EncryptionEnvelope;
  const sdek = await getSdek(accountKey, env.keyVersion);
  const value = decryptWithSdek(env, sdek, buildRulesetAad(rulesetId, revision)) as Partial<RulesetPlaintext> | null;
  if (!value || value.v !== 1 || typeof value.name !== "string" || !Array.isArray(value.rules)) {
    throw new Error("malformed ruleset");
  }
  return { v: 1, name: value.name, rules: value.rules.filter(isRule) };
}

export interface LoadedRulesets {
  effective: EffectiveRules;
  /** Stored rulesets that no longer decrypt (a wrong key after a password
   * reset, a tampered envelope). They apply as they were last known, or not
   * at all if they never decrypted. */
  unreadable: number;
}

let cache: { record: RulesetsRecord | undefined; loaded: LoadedRulesets } | null = null;

export function invalidateRulesetsMemory(): void {
  cache = null;
}

async function loadFrom(record: RulesetsRecord | undefined): Promise<LoadedRulesets> {
  if (!record || record.rulesets.length === 0) return { effective: NO_RULES, unreadable: 0 };
  const device = await getDevice();
  if (!device) return { effective: NO_RULES, unreadable: 0 };

  const plaintexts: Array<RulesetPlaintext & { isDefault: boolean }> = [];
  let unreadable = 0;
  for (const stored of record.rulesets) {
    const plaintext = await plaintextOf(device.accountKey, stored);
    if (plaintext) plaintexts.push({ ...plaintext, isDefault: stored.isDefault });
    else unreadable++;
  }
  return { effective: combineRulesets(plaintexts), unreadable };
}

/** The contents of a stored ruleset: none for a Default with no envelope
 * (an empty ruleset), `null` when it can't be decrypted. */
async function plaintextOf(accountKey: string, stored: StoredRuleset): Promise<RulesetPlaintext | null> {
  if (stored.envelope === null) {
    return stored.isDefault ? { v: 1, name: "", rules: [] } : null;
  }
  try {
    return await decryptRuleset(accountKey, stored.id, stored.revision, stored.envelope);
  } catch (e) {
    console.error("HelixSync: a stored ruleset could not be decrypted", stored.id, e);
    return null;
  }
}

/** The rules this device enforces right now, from what it last fetched. No
 * rules before the first fetch (and for a device in no ruleset). */
export async function getLoadedRulesets(): Promise<LoadedRulesets> {
  const record = await getRulesetsRecord();
  if (cache && cache.record === record) return cache.loaded;
  // The record object is new on every read, so compare what identifies it.
  if (cache && sameRecord(cache.record, record)) return cache.loaded;
  const loaded = await loadFrom(record);
  cache = { record, loaded };
  return loaded;
}

function sameRecord(a: RulesetsRecord | undefined, b: RulesetsRecord | undefined): boolean {
  if (!a || !b) return a === b;
  return (
    a.fetchedAt === b.fetchedAt &&
    a.rulesets.length === b.rulesets.length &&
    a.rulesets.every((r, i) => r.id === b.rulesets[i].id && r.revision === b.rulesets[i].revision)
  );
}

export async function getEffectiveRules(): Promise<EffectiveRules> {
  return (await getLoadedRulesets()).effective;
}
