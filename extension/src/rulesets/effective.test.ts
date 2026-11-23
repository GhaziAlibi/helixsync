import { describe, expect, it } from "vitest";
import {
  NO_RULES,
  combineRulesets,
  folderRulesOf,
  foldersWidened,
  isFolderExcluded,
  isUrlBlocked,
  sameFolderRules,
} from "./effective";
import type { Rule } from "./types";

const set = (name: string, rules: Rule[], isDefault = false) => ({ v: 1 as const, name, rules, isDefault });
const domain = (d: string): Rule => ({ id: d, kind: "blockDomain", domain: d });
const pattern = (p: string): Rule => ({ id: p, kind: "blockPattern", pattern: p });
const exclude = (f: string): Rule => ({ id: `x${f}`, kind: "excludeFolder", folderId: f });
const include = (f: string): Rule => ({ id: `i${f}`, kind: "includeFolder", folderId: f });
const local: Rule = { id: "l", kind: "blockLocal" };

describe("combining rulesets (§2.1)", () => {
  it("an empty Default is no rules and hashes as nothing", () => {
    const rules = combineRulesets([set("Default", [], true)]);
    expect(rules.hash).toBe("");
    expect(isUrlBlocked("https://example.com/", rules)).toBe(false);
    expect(isFolderExcluded(["a", "b"], rules)).toBe(false);
    expect(rules.rulesets).toEqual([{ name: "Default", isDefault: true }]);
    expect(NO_RULES.hash).toBe("");
  });

  it("a URL is blocked when any ruleset blocks it", () => {
    const rules = combineRulesets([
      set("Default", [], true),
      set("Work", [local]),
      set("Social", [domain("facebook.com"), domain("instagram.com")]),
    ]);
    expect(isUrlBlocked("http://localhost:3000/", rules)).toBe(true);
    expect(isUrlBlocked("https://m.facebook.com/x", rules)).toBe(true);
    expect(isUrlBlocked("https://instagram.com/", rules)).toBe(true);
    expect(isUrlBlocked("https://example.com/", rules)).toBe(false);
  });

  it("include rules of several rulesets are a union, and an exclude anywhere wins", () => {
    const rules = combineRulesets([
      set("Work", [include("work")]),
      set("Social", [include("social")]),
      set("Private", [exclude("work-secrets")]),
    ]);
    expect(isFolderExcluded(["work"], rules)).toBe(false);
    expect(isFolderExcluded(["x", "social", "bar"], rules)).toBe(false);
    expect(isFolderExcluded(["other", "bar"], rules)).toBe(true); // under no included folder
    expect(isFolderExcluded(["bm", "work-secrets", "work", "bar"], rules)).toBe(true); // exclude wins
  });

  it("without include rules only excluded subtrees are left out", () => {
    const rules = combineRulesets([set("A", [exclude("p")])]);
    expect(isFolderExcluded(["leaf", "p", "bar"], rules)).toBe(true);
    expect(isFolderExcluded(["p"], rules)).toBe(true);
    expect(isFolderExcluded(["leaf", "q", "bar"], rules)).toBe(false);
  });

  it("the hash depends on the content, not on which ruleset holds a rule or in what order", () => {
    const a = combineRulesets([set("A", [domain("a.com"), local]), set("B", [exclude("f")])]);
    const b = combineRulesets([set("B", [exclude("f"), local]), set("A", [domain("a.com")])]);
    const c = combineRulesets([set("A", [domain("a.com"), local])]);
    expect(a.hash).not.toBe("");
    expect(a.hash).toBe(b.hash);
    expect(c.hash).not.toBe(a.hash);
  });

  it("duplicates collapse, and a bad rule matches nothing without breaking the rest", () => {
    const rules = combineRulesets([
      set("A", [domain("a.com"), domain("https://A.com/x"), pattern("("), domain("not a domain")]),
    ]);
    expect(rules.domains.size).toBe(1);
    expect(rules.patterns).toHaveLength(0);
    expect(isUrlBlocked("https://a.com/", rules)).toBe(true);
  });
});

describe("isUrlBlocked", () => {
  const rules = combineRulesets([
    set("A", [domain("example.com"), domain("bücher.de"), domain("192.168.1.10"), pattern("\\.pdf($|\\?)")]),
  ]);

  it("matches on dot boundaries only", () => {
    expect(isUrlBlocked("https://example.com", rules)).toBe(true);
    expect(isUrlBlocked("https://a.b.example.com/x", rules)).toBe(true);
    expect(isUrlBlocked("https://notexample.com", rules)).toBe(false);
    expect(isUrlBlocked("https://example.com.evil.test", rules)).toBe(false);
  });

  it("ignores ports and userinfo", () => {
    expect(isUrlBlocked("https://u:p@example.com:8443/x", rules)).toBe(true);
    expect(isUrlBlocked("http://192.168.1.10:3000/", rules)).toBe(true);
    expect(isUrlBlocked("http://192.168.1.100/", rules)).toBe(false);
  });

  it("matches an IDN by its punycode host", () => {
    expect(isUrlBlocked("https://shop.bücher.de/", rules)).toBe(true);
    expect(isUrlBlocked("https://xn--bcher-kva.de/", rules)).toBe(true);
  });

  it("applies patterns to the whole address, including non-web schemes", () => {
    expect(isUrlBlocked("https://other.test/doc.pdf?dl=1", rules)).toBe(true);
    expect(isUrlBlocked("https://other.test/doc.pdfx", rules)).toBe(false);
    expect(isUrlBlocked("chrome://settings", rules)).toBe(false);
  });

  it("blocks IPv6 loopback with blockLocal", () => {
    const l = combineRulesets([set("L", [local])]);
    expect(isUrlBlocked("http://[::1]:8080/", l)).toBe(true);
    expect(isUrlBlocked("http://[2001:db8::1]/", l)).toBe(false);
  });
});

describe("foldersWidened", () => {
  const f = (excluded: string[], included: string[] = []) => ({ excluded: excluded.sort(), included: included.sort() });
  it("is true when an excluded folder is lifted", () => {
    expect(foldersWidened(f(["a", "b"]), f(["a"]))).toBe(true);
    expect(foldersWidened(f(["a"]), f([]))).toBe(true);
  });
  it("is true when an include rule is added next to others, or include mode ends", () => {
    expect(foldersWidened(f([], ["w"]), f([], ["w", "s"]))).toBe(true);
    expect(foldersWidened(f([], ["w"]), f([], []))).toBe(true);
  });
  it("is false when rules only narrow or stay", () => {
    expect(foldersWidened(f([]), f(["a"]))).toBe(false);
    expect(foldersWidened(f([]), f([], ["w"]))).toBe(false); // first include narrows
    expect(foldersWidened(f([], ["w", "s"]), f([], ["w"]))).toBe(false);
    expect(foldersWidened(f(["a"], ["w"]), f(["a"], ["w"]))).toBe(false);
  });
  it("compares and extracts folder rules", () => {
    const rules = combineRulesets([set("A", [exclude("b"), exclude("a"), include("z")])]);
    expect(folderRulesOf(rules)).toEqual({ excluded: ["a", "b"], included: ["z"] });
    expect(sameFolderRules(folderRulesOf(rules), { excluded: ["a", "b"], included: ["z"] })).toBe(true);
    expect(sameFolderRules(folderRulesOf(rules), { excluded: ["a"], included: ["z"] })).toBe(false);
  });
});
