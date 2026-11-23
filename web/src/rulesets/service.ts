// What the Rulesets page does with the API and the account key, kept apart
// from React so it can be tested.
import * as api from "../api/client";
import { decryptRuleset, encryptRuleset } from "./codec";
import { ruleBlocksUrl } from "./match";
import type { Rule, RulesetPlaintext } from "./types";

/** The first extension version that fetches and enforces rulesets. Older
 * ones ignore them, so the page flags assigned devices below this. */
export const MIN_RULESET_EXTENSION_VERSION = "1.2.0";

/** The name stored for a Default ruleset's first save. The page shows the
 * translated name for a Default whatever is stored here. */
export const DEFAULT_RULESET_NAME = "Default";

export interface DecryptedRuleset {
  id: string;
  revision: number;
  isDefault: boolean;
  deviceIds: string[];
  /** `null` when the envelope couldn't be decrypted: shown, but not editable. */
  plaintext: RulesetPlaintext | null;
}

/** Decrypts every ruleset the server returned. An untouched Default (no
 * envelope) is an empty ruleset; one that fails to decrypt has no plaintext. */
export async function decryptRulesets(accountKey: Uint8Array, entries: api.RulesetEntry[]): Promise<DecryptedRuleset[]> {
  return Promise.all(
    entries.map(async (e) => {
      let plaintext: RulesetPlaintext | null;
      if (e.envelope === null) {
        plaintext = { v: 1, name: DEFAULT_RULESET_NAME, rules: [] };
      } else {
        try {
          plaintext = await decryptRuleset(accountKey, e.id, e.revision, e.envelope);
        } catch {
          plaintext = null;
        }
      }
      return { id: e.id, revision: e.revision, isDefault: e.isDefault, deviceIds: e.deviceIds, plaintext };
    }),
  );
}

export async function loadRulesets(accountKey: Uint8Array): Promise<DecryptedRuleset[]> {
  return decryptRulesets(accountKey, await api.listRulesets());
}

/** Creates a ruleset with a fresh id (returned); its envelope is revision 1. */
export async function createRuleset(accountKey: Uint8Array, plaintext: RulesetPlaintext): Promise<string> {
  const id = crypto.randomUUID();
  const keyVersion = await api.getAccountKeyVersion();
  await api.createRuleset(id, await encryptRuleset(accountKey, keyVersion, id, 1, plaintext));
  return id;
}

/** Saves `plaintext` over `current`, as revision `current.revision + 1`. A
 * 409 `revision_conflict` means another tab or person saved first. */
export async function saveRuleset(
  accountKey: Uint8Array,
  current: Pick<DecryptedRuleset, "id" | "revision">,
  plaintext: RulesetPlaintext,
): Promise<void> {
  const keyVersion = await api.getAccountKeyVersion();
  const envelope = await encryptRuleset(accountKey, keyVersion, current.id, current.revision + 1, plaintext);
  await api.updateRuleset(current.id, current.revision, envelope);
}

/** The rulesets a device is assigned to, Default first (as listed). */
export function rulesetsOfDevice(deviceId: string, rulesets: DecryptedRuleset[]): DecryptedRuleset[] {
  return rulesets.filter((r) => r.deviceIds.includes(deviceId));
}

/** What `https://` should be put in front of: an address typed without a scheme. */
export function toTestUrl(input: string): string {
  const text = input.trim();
  return /^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[a-z0-9.-]+:\d+(\/|$)/i.test(text) ? text : `https://${text}`;
}

export interface BlockingRule {
  ruleset: DecryptedRuleset;
  rule: Rule;
}

/** The first rule, over the device's rulesets in order, that blocks `input`;
 * `null` when none does. Only rules the extension would apply count: folder
 * rules never block an address. */
export function findBlockingRule(input: string, deviceId: string, rulesets: DecryptedRuleset[]): BlockingRule | null {
  const url = toTestUrl(input);
  for (const ruleset of rulesetsOfDevice(deviceId, rulesets)) {
    for (const rule of ruleset.plaintext?.rules ?? []) {
      if (ruleBlocksUrl(rule, url)) return { ruleset, rule };
    }
  }
  return null;
}

/** Numeric dotted comparison of two versions, ignoring a pre-release suffix.
 * Negative when `a < b`. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split(/[-+]/, 1)[0].split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** True when the device can't be relied on to enforce rulesets: its extension
 * is older than `MIN_RULESET_EXTENSION_VERSION`, or it never reported one. */
export function ignoresRulesets(extensionVersion: string | null): boolean {
  return extensionVersion === null || compareVersions(extensionVersion, MIN_RULESET_EXTENSION_VERSION) < 0;
}

/** Number of rules, for the list. */
export function ruleCount(ruleset: DecryptedRuleset): number {
  return ruleset.plaintext?.rules.length ?? 0;
}
