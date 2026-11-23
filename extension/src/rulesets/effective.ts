// The rules a device enforces: the union of the rules of every ruleset it is
// assigned to (docs/protocol.md §17.3).
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { MAX_MATCHED_URL_LENGTH, compilePattern, hostOf, isLocalHost, normalizeDomain } from "./match";
import type { RulesetPlaintext } from "./types";

export interface RulesetSummary {
  name: string;
  isDefault: boolean;
}

export interface EffectiveRules {
  /** Hash of the rules' content: the same rules always hash the same, whichever
   * rulesets they came from. `""` when there are no rules at all, so a device
   * with none hashes as it did before rulesets existed. */
  hash: string;
  /** The rulesets these came from, for display. */
  rulesets: readonly RulesetSummary[];
  blockLocal: boolean;
  /** Normalized hosts; a host and its subdomains are blocked. */
  domains: ReadonlySet<string>;
  patterns: readonly RegExp[];
  /** Bookmark objectIds. */
  excludedFolders: ReadonlySet<string>;
  includedFolders: ReadonlySet<string>;
}

export const NO_RULES: EffectiveRules = {
  hash: "",
  rulesets: [],
  blockLocal: false,
  domains: new Set(),
  patterns: [],
  excludedFolders: new Set(),
  includedFolders: new Set(),
};

export interface FolderRules {
  excluded: string[];
  included: string[];
}

export function folderRulesOf(rules: EffectiveRules): FolderRules {
  return { excluded: [...rules.excludedFolders].sort(), included: [...rules.includedFolders].sort() };
}

const textEncoder = new TextEncoder();

/** Combines rulesets by union. A ruleset with an unknown or malformed rule
 * keeps the rest: unknown kinds were already dropped when it was decrypted,
 * a domain that doesn't normalize matches nothing. */
export function combineRulesets(rulesets: ReadonlyArray<RulesetPlaintext & { isDefault: boolean }>): EffectiveRules {
  let blockLocal = false;
  const domains = new Set<string>();
  const patternSources = new Set<string>();
  const excluded = new Set<string>();
  const included = new Set<string>();

  for (const ruleset of rulesets) {
    for (const rule of ruleset.rules) {
      switch (rule.kind) {
        case "blockLocal":
          blockLocal = true;
          break;
        case "blockDomain": {
          const domain = normalizeDomain(rule.domain);
          if (domain !== null) domains.add(domain);
          break;
        }
        case "blockPattern":
          if (compilePattern(rule.pattern) !== null) patternSources.add(rule.pattern);
          break;
        case "excludeFolder":
          excluded.add(rule.folderId);
          break;
        case "includeFolder":
          included.add(rule.folderId);
          break;
      }
    }
  }

  const summaries = rulesets.map((r) => ({ name: r.name, isDefault: r.isDefault }));
  const sortedDomains = [...domains].sort();
  const sortedPatterns = [...patternSources].sort();
  const sortedExcluded = [...excluded].sort();
  const sortedIncluded = [...included].sort();
  const empty =
    !blockLocal &&
    sortedDomains.length === 0 &&
    sortedPatterns.length === 0 &&
    sortedExcluded.length === 0 &&
    sortedIncluded.length === 0;

  return {
    hash: empty
      ? ""
      : bytesToHex(
          sha256(
            textEncoder.encode(
              JSON.stringify({ l: blockLocal, d: sortedDomains, p: sortedPatterns, x: sortedExcluded, i: sortedIncluded }),
            ),
          ),
        ),
    rulesets: summaries,
    blockLocal,
    domains,
    patterns: sortedPatterns.map((p) => compilePattern(p)!),
    excludedFolders: excluded,
    includedFolders: included,
  };
}

/** True when any address rule exists. */
export function hasUrlRules(rules: EffectiveRules): boolean {
  return rules.blockLocal || rules.domains.size > 0 || rules.patterns.length > 0;
}

/** True when any bookmark folder rule exists. */
export function hasFolderRules(rules: EffectiveRules): boolean {
  return rules.excludedFolders.size > 0 || rules.includedFolders.size > 0;
}

/** True when some rule blocks `url`. */
export function isUrlBlocked(url: string, rules: EffectiveRules): boolean {
  if (!hasUrlRules(rules)) return false;
  const host = hostOf(url);
  if (host !== null) {
    if (rules.blockLocal && isLocalHost(host)) return true;
    if (rules.domains.size > 0) {
      // The host and each parent domain of it.
      let candidate = host;
      for (;;) {
        if (rules.domains.has(candidate)) return true;
        const dot = candidate.indexOf(".");
        if (dot === -1) break;
        candidate = candidate.slice(dot + 1);
      }
    }
  }
  if (rules.patterns.length > 0) {
    const text = url.slice(0, MAX_MATCHED_URL_LENGTH);
    for (const re of rules.patterns) if (re.test(text)) return true;
  }
  return false;
}

/** Whether a bookmark node is left out of sync. `chain` is the objectIds from
 * the node up to its root, the node's own first (a bookmark has none of its
 * own yet: pass only its ancestors). Excluded when any of them is under an
 * `excludeFolder`; and, when any `includeFolder` rule exists, also when none
 * of them is an `includeFolder`. Exclude always wins. */
export function isFolderExcluded(chain: readonly string[], rules: EffectiveRules): boolean {
  if (rules.excludedFolders.size > 0 && chain.some((id) => rules.excludedFolders.has(id))) return true;
  if (rules.includedFolders.size > 0 && !chain.some((id) => rules.includedFolders.has(id))) return true;
  return false;
}

/** True when `next` lets sync reach something `prev` kept out: an excluded
 * folder removed, an include rule added next to existing ones, or include mode
 * switched off. Used to decide whether a rule change needs a catch-up. */
export function foldersWidened(prev: FolderRules, next: FolderRules): boolean {
  if (prev.excluded.some((id) => !next.excluded.includes(id))) return true;
  if (prev.included.length === 0) return false;
  if (next.included.length === 0) return true;
  return next.included.some((id) => !prev.included.includes(id));
}

export function sameFolderRules(a: FolderRules, b: FolderRules): boolean {
  return a.excluded.join(",") === b.excluded.join(",") && a.included.join(",") === b.included.join(",");
}
