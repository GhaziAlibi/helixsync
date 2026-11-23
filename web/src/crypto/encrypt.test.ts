import { beforeEach, describe, expect, it, vi } from "vitest";
import vectors from "../vault/fixtures/extension-vectors.json";

// `encryptBytesWithSdek` draws its nonce from `randomBytes`. Pinning it to the
// nonce in an extension-produced vector makes the output comparable byte for
// byte with what the extension's own encryptor produced.
const pinned = vi.hoisted(() => ({ nonce: null as Uint8Array | null }));
vi.mock("@noble/hashes/utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@noble/hashes/utils.js")>();
  return {
    ...actual,
    randomBytes: (n?: number) => (pinned.nonce && n === 24 ? pinned.nonce : actual.randomBytes(n)),
  };
});

import {
  buildOperationAad,
  buildRulesetAad,
  decryptBytesWithSdek,
  decryptWithSdek,
  encryptBytesWithSdek,
  encryptWithSdek,
  fromB64,
  getSdek,
} from "./index";

const accountKey = fromB64(vectors.akB64);

beforeEach(() => {
  pinned.nonce = null;
});

describe("encryptBytesWithSdek vs the extension's output", () => {
  it("reproduces the extension's bookmark envelope byte for byte", async () => {
    const v = vectors.bookmark;
    pinned.nonce = fromB64(v.envelope.nonce);
    const sdek = await getSdek(accountKey, 1);
    const envelope = encryptWithSdek(
      v.plaintext,
      sdek,
      1,
      buildOperationAad(v.objectType, v.objectId, v.operationType),
    );
    expect(envelope).toEqual(v.envelope);
  });

  it("reproduces the extension's history visit envelope byte for byte", async () => {
    const v = vectors.visit;
    pinned.nonce = fromB64(v.envelope.nonce);
    const sdek = await getSdek(accountKey, 1);
    const envelope = encryptWithSdek(v.plaintext, sdek, 1, buildOperationAad("historyVisit", v.objectId, "visit"));
    expect(envelope).toEqual(v.envelope);
  });

  it("produces envelopes the decryptor reads back", async () => {
    const sdek = await getSdek(accountKey, 1);
    const aad = buildOperationAad("bookmark", vectors.bookmark.objectId, "create");
    const bytes = crypto.getRandomValues(new Uint8Array(1000));
    const envelope = encryptBytesWithSdek(bytes, sdek, 1, aad);
    expect(decryptBytesWithSdek(envelope, sdek, aad)).toEqual(bytes);
  });

  it("uses a fresh nonce every time", async () => {
    const sdek = await getSdek(accountKey, 1);
    const aad = buildOperationAad("bookmark", "x", "create");
    const a = encryptBytesWithSdek(new Uint8Array([1]), sdek, 1, aad);
    const b = encryptBytesWithSdek(new Uint8Array([1]), sdek, 1, aad);
    expect(a.nonce).not.toBe(b.nonce);
    expect(fromB64(a.nonce)).toHaveLength(24);
  });

  it("fails to decrypt under a different aad", async () => {
    const sdek = await getSdek(accountKey, 1);
    const envelope = encryptWithSdek({ a: 1 }, sdek, 1, buildOperationAad("bookmark", "x", "create"));
    expect(() => decryptWithSdek(envelope, sdek, buildOperationAad("bookmark", "y", "create"))).toThrow();
  });
});

describe("ruleset AAD", () => {
  const id = "0198f1d1-5e12-7a11-9d0a-2f2d1f6a7c30";

  it("is the JSON of [syncRuleset, id, revision] with a numeric revision", () => {
    expect(new TextDecoder().decode(buildRulesetAad(id, 3))).toBe(`["syncRuleset","${id}",3]`);
  });

  it("binds the id and the revision", async () => {
    const sdek = await getSdek(accountKey, 1);
    const envelope = encryptWithSdek({ v: 1 }, sdek, 1, buildRulesetAad(id, 2));
    expect(decryptWithSdek(envelope, sdek, buildRulesetAad(id, 2))).toEqual({ v: 1 });
    expect(() => decryptWithSdek(envelope, sdek, buildRulesetAad(id, 1))).toThrow();
    expect(() => decryptWithSdek(envelope, sdek, buildRulesetAad(id.replace("30", "31"), 2))).toThrow();
    // Not an operation envelope either.
    expect(() => decryptWithSdek(envelope, sdek, buildOperationAad("syncRuleset", id, "2"))).toThrow();
  });
});
