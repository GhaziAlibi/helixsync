// Fetching this device's rulesets (docs/protocol.md §17.2).
//
// Triggers: startup, every periodic sync, the WebSocket `ruleset_changed`
// hint. Offline keeps what was last known. A ruleset that fails to decrypt
// keeps its last known version; only an untouched Default (no envelope) is
// "no rules".
import { fetchOwnRulesets, serverSupportsRulesets, type OwnRulesetDto } from "../api/client";
import { getDevice, getRulesetsRecord, putRulesetsRecord, type RulesetsRecord, type StoredRuleset } from "../storage/db";
import { folderRulesOf, hasFolderRules, sameFolderRules, type EffectiveRules } from "./effective";
import { NO_RULES, decryptRuleset, getLoadedRulesets, invalidateRulesetsMemory } from "./index";

export type RefreshOutcome =
  | "no-device"
  | "unsupported" // the server has no rulesets: no rules
  | "unchanged"
  | "updated";

type ChangeListener = (rules: EffectiveRules) => void;
const listeners = new Set<ChangeListener>();

/** Called after a fetch changes the effective rules (not after one that found
 * the same rulesets again). */
export function onRulesChanged(listener: ChangeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Rulesets that failed to decrypt in the latest fetch, for the popup.
let lastFailedCount = 0;
export function failedRulesetCount(): number {
  return lastFailedCount;
}

/** Periodic and startup checks wait at least this long since the last
 * successful fetch; a push forces one. */
const MIN_REFETCH_INTERVAL_MS = 60_000;
let lastFetchAt = 0;

function sameList(stored: StoredRuleset[], fetched: OwnRulesetDto[]): boolean {
  return (
    stored.length === fetched.length &&
    stored.every((s, i) => s.id === fetched[i].id && s.revision === fetched[i].revision && s.isDefault === fetched[i].isDefault)
  );
}

function validDto(r: OwnRulesetDto): boolean {
  return (
    typeof r?.id === "string" && Number.isInteger(r.revision) && r.revision >= 1 && typeof r.isDefault === "boolean"
  );
}

async function doRefresh(force: boolean): Promise<RefreshOutcome> {
  const device = await getDevice();
  if (!device) return "no-device";
  if (!force && Date.now() - lastFetchAt < MIN_REFETCH_INTERVAL_MS) return "unchanged";

  // Throws when the server can't be asked: callers that must not import
  // unfiltered (startup) then wait instead of assuming "no rulesets".
  const supported = await serverSupportsRulesets();
  const previous = await getRulesetsRecord();
  const before = (await getLoadedRulesets()).effective;

  if (!supported) {
    lastFetchAt = Date.now();
    lastFailedCount = 0;
    if (previous) {
      await putRulesetsRecord({ id: "self", rulesets: [], fetchedAt: new Date().toISOString() });
      invalidateRulesetsMemory();
      announce(before, NO_RULES);
    }
    return "unsupported";
  }

  const fetched = (await fetchOwnRulesets()).filter(validDto);
  lastFetchAt = Date.now();

  if (previous && sameList(previous.rulesets, fetched)) {
    lastFailedCount = (await getLoadedRulesets()).unreadable;
    return "unchanged";
  }

  const known = new Map((previous?.rulesets ?? []).map((r) => [r.id, r]));
  const next: StoredRuleset[] = [];
  let failed = 0;
  for (const r of fetched) {
    const stored: StoredRuleset = { id: r.id, revision: r.revision, isDefault: r.isDefault, envelope: r.envelope ?? null };
    // A revision never goes down. An older pair of (revision, envelope) is a
    // valid ciphertext, so the AAD alone can't tell it from a current one: a
    // server could replay it to lift a rule. The version already held stays.
    const held = known.get(r.id);
    if (held && r.revision < held.revision) {
      failed++;
      console.error("HelixSync: ruleset revision went backwards; keeping the one held", r.id, r.revision, held.revision);
      next.push(held);
      continue;
    }
    if (stored.envelope === null) {
      if (stored.isDefault) {
        next.push(stored);
        continue;
      }
      // Only a Default may have no envelope.
      failed++;
      const old = known.get(r.id);
      if (old) next.push(old);
      continue;
    }
    try {
      await decryptRuleset(device.accountKey, r.id, r.revision, stored.envelope);
      next.push(stored);
    } catch (e) {
      failed++;
      console.error("HelixSync: ruleset could not be decrypted; keeping the last known version", r.id, e);
      const old = known.get(r.id);
      if (old) next.push(old);
    }
  }
  lastFailedCount = failed;

  // The device may have been disconnected while the requests ran.
  if (!(await getDevice())) return "no-device";
  const record: RulesetsRecord = {
    id: "self",
    rulesets: next,
    fetchedAt: new Date().toISOString(),
    appliedFolderRules: previous?.appliedFolderRules,
  };
  await putRulesetsRecord(record);
  invalidateRulesetsMemory();
  announce(before, (await getLoadedRulesets()).effective);
  return "updated";
}

function announce(before: EffectiveRules, after: EffectiveRules): void {
  const changed =
    before.hash !== after.hash || !sameFolderRules(folderRulesOf(before), folderRulesOf(after)) || hasFolderRules(before) !== hasFolderRules(after);
  if (!changed) return;
  for (const listener of [...listeners]) {
    try {
      listener(after);
    } catch (e) {
      console.error("HelixSync: ruleset change listener failed", e);
    }
  }
}

let inFlight: Promise<RefreshOutcome> | null = null;

/** Fetches the device's rulesets if due (or `force`), verifies and stores
 * them. Throws when the server can't be reached or the fetch fails: whatever
 * was last known keeps applying. Calls that aren't forced share a run already
 * in flight; a forced one (a push, startup) waits for it and then fetches
 * again, since that run may have started before the change it was told of. */
export async function refreshRulesets(force: boolean = false): Promise<RefreshOutcome> {
  while (inFlight) {
    if (!force) return inFlight;
    await inFlight.catch(() => {});
  }
  const run = doRefresh(force).finally(() => {
    if (inFlight === run) inFlight = null;
  });
  inFlight = run;
  return run;
}
