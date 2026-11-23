import { describe, expect, it } from "vitest";
import vectors from "./fixtures/matcher-vectors.json";
import { hostOf, isLocalHost, normalizeDomain, ruleBlocksUrl } from "./match";
import type { Rule } from "./types";

describe("matcher vectors shared with the extension", () => {
  for (const c of vectors.cases) {
    const rule = { id: "r", ...c.rule } as Rule;
    it(`${c.rule.kind} ${JSON.stringify(c.rule.domain ?? c.rule.pattern ?? "")} vs ${c.url} -> ${c.blocked}`, () => {
      expect(ruleBlocksUrl(rule, c.url)).toBe(c.blocked);
    });
  }
});

describe("hostOf", () => {
  it("lower-cases, drops brackets and the trailing dot", () => {
    expect(hostOf("https://WWW.Example.com./x")).toBe("www.example.com");
    expect(hostOf("http://[::1]:80/")).toBe("::1");
  });
  it("has no host for non-web or unparsable addresses", () => {
    expect(hostOf("chrome://settings")).toBeNull();
    expect(hostOf("file:///a")).toBeNull();
    expect(hostOf("nope")).toBeNull();
  });
});

describe("normalizeDomain", () => {
  it("accepts what people paste", () => {
    expect(normalizeDomain(" https://www.Example.com/a?b#c ")).toBe("www.example.com");
    expect(normalizeDomain("*.example.com")).toBe("example.com");
    expect(normalizeDomain(".example.com")).toBe("example.com");
    expect(normalizeDomain("example.com:8080")).toBe("example.com");
    expect(normalizeDomain("bücher.de")).toBe("xn--bcher-kva.de");
    expect(normalizeDomain("user@example.com")).toBe("example.com");
  });
  it("rejects what isn't a host", () => {
    for (const bad of ["", "   ", "a b.com", "exa$mple.com", "a..b", "http://", "-"]) {
      expect(normalizeDomain(bad), bad).toBeNull();
    }
  });
});

describe("isLocalHost", () => {
  it("covers the documented ranges and nothing near them", () => {
    expect(isLocalHost("localhost")).toBe(true);
    expect(isLocalHost("10.0.0.1")).toBe(true);
    expect(isLocalHost("172.16.0.1")).toBe(true);
    expect(isLocalHost("172.32.0.1")).toBe(false);
    expect(isLocalHost("1.2.3.4")).toBe(false);
    expect(isLocalHost("256.0.0.1")).toBe(false);
    expect(isLocalHost("local")).toBe(false);
  });
});
