import { compilePattern, normalizeDomain } from "./match";
import {
  MAX_NAME_LENGTH,
  MAX_PATTERN_LENGTH,
  MAX_PATTERN_RULES,
  MAX_RULES,
  type Rule,
  type RulesetPlaintext,
} from "./types";

/** A short random id for a rule (12 characters of base64url). Short on
 * purpose: a ruleset holds up to 500 rules and its envelope is capped. */
export function newRuleId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

export type RuleProblem = "empty" | "tooLong" | "invalidDomain" | "invalidPattern" | "duplicate" | "tooManyPatterns" | "tooManyRules";

/** Why a rule can't be added to `rules`, or `null` when it can. */
export function checkNewRule(rules: Rule[], rule: Rule): RuleProblem | null {
  if (rules.length >= MAX_RULES) return "tooManyRules";
  switch (rule.kind) {
    case "blockDomain": {
      if (rule.domain.trim() === "") return "empty";
      const domain = normalizeDomain(rule.domain);
      if (domain === null) return "invalidDomain";
      return rules.some((r) => r.kind === "blockDomain" && normalizeDomain(r.domain) === domain) ? "duplicate" : null;
    }
    case "blockPattern": {
      if (rule.pattern === "") return "empty";
      if (rule.pattern.length > MAX_PATTERN_LENGTH) return "tooLong";
      if (compilePattern(rule.pattern) === null) return "invalidPattern";
      if (rules.filter((r) => r.kind === "blockPattern").length >= MAX_PATTERN_RULES) return "tooManyPatterns";
      return rules.some((r) => r.kind === "blockPattern" && r.pattern === rule.pattern) ? "duplicate" : null;
    }
    case "excludeFolder":
    case "includeFolder":
      return rules.some((r) => r.kind === rule.kind && r.folderId === rule.folderId) ? "duplicate" : null;
    case "blockLocal":
      return rules.some((r) => r.kind === "blockLocal") ? "duplicate" : null;
  }
}

/** The rule as stored: a domain rule keeps only the normalized host. */
export function normalizeRule(rule: Rule): Rule {
  if (rule.kind === "blockDomain") return { ...rule, domain: normalizeDomain(rule.domain) ?? rule.domain };
  return rule;
}

export type RulesetProblem = "emptyName" | "nameTooLong" | "tooManyRules" | "tooManyPatterns";

export function checkRuleset(ruleset: RulesetPlaintext): RulesetProblem | null {
  const name = ruleset.name.trim();
  if (name === "") return "emptyName";
  if (name.length > MAX_NAME_LENGTH) return "nameTooLong";
  if (ruleset.rules.length > MAX_RULES) return "tooManyRules";
  if (ruleset.rules.filter((r) => r.kind === "blockPattern").length > MAX_PATTERN_RULES) return "tooManyPatterns";
  return null;
}
