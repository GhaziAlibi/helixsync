import { describe, expect, it } from "vitest";
import { checkNewRule, checkRuleset, newRuleId, normalizeRule } from "./validate";
import type { Rule } from "./types";

const domain = (d: string): Rule => ({ id: "x", kind: "blockDomain", domain: d });
const pattern = (p: string): Rule => ({ id: "x", kind: "blockPattern", pattern: p });

describe("newRuleId", () => {
  it("is 12 url-safe characters and different each time", () => {
    const a = newRuleId();
    expect(a).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(newRuleId()).not.toBe(a);
  });
});

describe("checkNewRule", () => {
  it("validates domains and spots duplicates after normalizing", () => {
    expect(checkNewRule([], domain("example.com"))).toBeNull();
    expect(checkNewRule([], domain(""))).toBe("empty");
    expect(checkNewRule([], domain("a b"))).toBe("invalidDomain");
    expect(checkNewRule([domain("example.com")], domain("https://Example.com/x"))).toBe("duplicate");
  });

  it("validates regexes: compiles, length, count", () => {
    expect(checkNewRule([], pattern("\\.pdf$"))).toBeNull();
    expect(checkNewRule([], pattern("("))).toBe("invalidPattern");
    expect(checkNewRule([], pattern(""))).toBe("empty");
    expect(checkNewRule([], pattern("a".repeat(201)))).toBe("tooLong");
    expect(checkNewRule([], pattern("a".repeat(200)))).toBeNull();
    const twenty = Array.from({ length: 20 }, (_, i) => pattern(`p${i}`));
    expect(checkNewRule(twenty, pattern("one-more"))).toBe("tooManyPatterns");
    expect(checkNewRule(twenty, domain("example.com"))).toBeNull();
  });

  it("allows one blockLocal and one of each folder", () => {
    const local: Rule = { id: "l", kind: "blockLocal" };
    expect(checkNewRule([local], { ...local, id: "m" })).toBe("duplicate");
    const ex: Rule = { id: "e", kind: "excludeFolder", folderId: "f1" };
    expect(checkNewRule([ex], { ...ex, id: "z" })).toBe("duplicate");
    expect(checkNewRule([ex], { ...ex, id: "z", kind: "includeFolder" })).toBeNull();
  });

  it("caps a ruleset at 500 rules", () => {
    const rules = Array.from({ length: 500 }, (_, i) => domain(`d${i}.com`));
    expect(checkNewRule(rules, domain("one.com"))).toBe("tooManyRules");
  });
});

describe("normalizeRule / checkRuleset", () => {
  it("stores the bare host of a domain rule", () => {
    expect(normalizeRule(domain("https://WWW.Example.com/x"))).toMatchObject({ domain: "www.example.com" });
  });
  it("needs a name", () => {
    expect(checkRuleset({ v: 1, name: "  ", rules: [] })).toBe("emptyName");
    expect(checkRuleset({ v: 1, name: "x".repeat(101), rules: [] })).toBe("nameTooLong");
    expect(checkRuleset({ v: 1, name: "Work", rules: [] })).toBeNull();
  });
});
