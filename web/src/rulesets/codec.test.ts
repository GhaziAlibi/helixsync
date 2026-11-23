import { describe, expect, it } from "vitest";
import { fromB64, generateAccountKey } from "../crypto";
import vectors from "../vault/fixtures/extension-vectors.json";
import { RulesetTooLargeError, decryptRuleset, encryptRuleset } from "./codec";
import type { RulesetPlaintext } from "./types";

const accountKey = fromB64(vectors.akB64);
const ID = "0198f1d1-5e12-7a11-9d0a-2f2d1f6a7c30";
const ruleset: RulesetPlaintext = {
  v: 1,
  name: "Work",
  rules: [
    { id: "a", kind: "excludeFolder", folderId: "f1" },
    { id: "b", kind: "blockDomain", domain: "example.com" },
    { id: "c", kind: "blockLocal" },
  ],
};

describe("ruleset codec", () => {
  it("round-trips", async () => {
    const envelope = await encryptRuleset(accountKey, 1, ID, 3, ruleset);
    expect(envelope).toMatchObject({ v: 2, keyVersion: 1, alg: "xchacha20poly1305" });
    expect(await decryptRuleset(accountKey, ID, 3, envelope)).toEqual(ruleset);
  });

  it("rejects another id, another revision, another key", async () => {
    const envelope = await encryptRuleset(accountKey, 1, ID, 3, ruleset);
    await expect(decryptRuleset(accountKey, ID.replace("30", "31"), 3, envelope)).rejects.toThrow();
    await expect(decryptRuleset(accountKey, ID, 2, envelope)).rejects.toThrow();
    await expect(decryptRuleset(accountKey, ID, 4, envelope)).rejects.toThrow();
    await expect(decryptRuleset(generateAccountKey(), ID, 3, envelope)).rejects.toThrow();
  });

  it("rejects an envelope of another format version", async () => {
    const envelope = await encryptRuleset(accountKey, 1, ID, 1, ruleset);
    await expect(decryptRuleset(accountKey, ID, 1, { ...envelope, v: 3 as never })).rejects.toThrow(/format v3/);
  });

  it("refuses to encrypt more than the server accepts", async () => {
    const big: RulesetPlaintext = {
      v: 1,
      name: "Big",
      rules: Array.from({ length: 500 }, (_, i) => ({ id: `${i}`, kind: "blockDomain" as const, domain: `${"a".repeat(60)}${i}.example.com` })),
    };
    await expect(encryptRuleset(accountKey, 1, ID, 1, big)).rejects.toBeInstanceOf(RulesetTooLargeError);
  });

  it("holds 500 folder rules under the cap", async () => {
    const rules: RulesetPlaintext = {
      v: 1,
      name: "Folders",
      rules: Array.from({ length: 500 }, (_, i) => ({
        id: `id${String(i).padStart(10, "0")}`,
        kind: "excludeFolder" as const,
        folderId: "0198f1d1-5e12-7a11-9d0a-2f2d1f6a7c20",
      })),
    };
    await expect(encryptRuleset(accountKey, 1, ID, 1, rules)).resolves.toBeDefined();
  });

  it("drops rules of an unknown shape instead of failing", async () => {
    const envelope = await encryptRuleset(accountKey, 1, ID, 1, {
      v: 1,
      name: "x",
      rules: [{ id: "a", kind: "blockLocal" }, { id: "b", kind: "somethingNew" }, { kind: "blockLocal" }] as never,
    });
    expect((await decryptRuleset(accountKey, ID, 1, envelope)).rules).toEqual([{ id: "a", kind: "blockLocal" }]);
  });
});
