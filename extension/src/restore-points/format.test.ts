import { afterEach, describe, expect, it } from "vitest";
import { getSdek, toB64, UnsupportedEnvelopeVersionError } from "../crypto";
import { resetDeflateSupportForTesting } from "../util/compression";
import {
  decodePoint,
  encodePoint,
  POINT_VERSION,
  UnreadableRestorePointError,
  UnsupportedRestorePointVersionError,
  validatePoint,
  type PointNode,
  type PointPlaintext,
} from "./format";

const ROOT = "00000000-0000-7000-8000-000000000001";
const uuid = (n: number) => `0190${n.toString(16).padStart(4, "0")}-0000-7000-8000-000000000000`;

function point(nodes: PointNode[]): PointPlaintext {
  return { v: POINT_VERSION, createdAt: "2026-11-04T10:00:00Z", deviceId: uuid(900), kind: "manual", nodes };
}

const tree: PointNode[] = [
  { o: uuid(1), k: "f", t: "Work", p: ROOT, x: "a0" },
  { o: uuid(2), k: "b", t: "Docs", u: "https://example.com/docs", p: uuid(1), x: "a1" },
];

const ak = toB64(crypto.getRandomValues(new Uint8Array(32)));
const resolveSdek = (keyVersion: number) => getSdek(ak, keyVersion);

afterEach(() => {
  resetDeflateSupportForTesting();
});

describe("encodePoint / decodePoint", () => {
  it("round-trips with compression", async () => {
    const id = uuid(10);
    const encoded = await encodePoint(point(tree), id, await resolveSdek(1), 1);
    expect(encoded.codec).toBe("deflate-raw");
    expect(encoded.envelope.v).toBe(2);
    expect(await decodePoint(encoded.envelope, encoded.codec, id, resolveSdek)).toEqual(point(tree));
  });

  it("round-trips without compression when it is unavailable", async () => {
    const original = globalThis.CompressionStream;
    // @ts-expect-error simulating a runtime without CompressionStream
    delete globalThis.CompressionStream;
    resetDeflateSupportForTesting();
    try {
      const id = uuid(11);
      const encoded = await encodePoint(point(tree), id, await resolveSdek(1), 1);
      expect(encoded.codec).toBeUndefined();
      expect(await decodePoint(encoded.envelope, undefined, id, resolveSdek)).toEqual(point(tree));
    } finally {
      globalThis.CompressionStream = original;
    }
  });

  it("compresses a large tree well below its plain size", async () => {
    const nodes: PointNode[] = [];
    for (let i = 0; i < 2000; i++) {
      nodes.push({ o: uuid(100 + i), k: "b", t: `Bookmark ${i}`, u: `https://example.com/page/${i}`, p: ROOT, x: `a${i.toString(36).padStart(4, "0")}` });
    }
    const id = uuid(12);
    const encoded = await encodePoint(point(nodes), id, await resolveSdek(1), 1);
    const plainSize = JSON.stringify(point(nodes)).length;
    expect(encoded.envelope.ciphertext.length).toBeLessThan(plainSize);
  });

  it("fails authentication for another point id (a swapped blob)", async () => {
    const encoded = await encodePoint(point(tree), uuid(20), await resolveSdek(1), 1);
    await expect(decodePoint(encoded.envelope, encoded.codec, uuid(21), resolveSdek)).rejects.toBeInstanceOf(
      UnreadableRestorePointError,
    );
  });

  it("fails authentication under another key", async () => {
    const id = uuid(22);
    const encoded = await encodePoint(point(tree), id, await resolveSdek(1), 1);
    const otherAk = toB64(crypto.getRandomValues(new Uint8Array(32)));
    await expect(decodePoint(encoded.envelope, encoded.codec, id, (v) => getSdek(otherAk, v))).rejects.toBeInstanceOf(
      UnreadableRestorePointError,
    );
  });

  it("is not accepted as an operation payload (different AAD)", async () => {
    const id = uuid(23);
    const encoded = await encodePoint(point(tree), id, await resolveSdek(1), 1);
    const { buildOperationAad, decryptWithSdek } = await import("../crypto");
    const sdek = await resolveSdek(1);
    expect(() =>
      decryptWithSdek(encoded.envelope, sdek, buildOperationAad("bookmark", id, "create")),
    ).toThrow();
  });

  it("rejects an unsupported envelope version as 'update needed'", async () => {
    const id = uuid(24);
    const encoded = await encodePoint(point(tree), id, await resolveSdek(1), 1);
    const future = { ...encoded.envelope, v: 3 };
    await expect(decodePoint(future, encoded.codec, id, resolveSdek)).rejects.toBeInstanceOf(
      UnsupportedEnvelopeVersionError,
    );
  });

  it("rejects an unsupported point version", async () => {
    const id = uuid(25);
    const encoded = await encodePoint({ ...point(tree), v: 2 as never }, id, await resolveSdek(1), 1);
    await expect(decodePoint(encoded.envelope, encoded.codec, id, resolveSdek)).rejects.toBeInstanceOf(
      UnsupportedRestorePointVersionError,
    );
  });

  it("rejects a malformed envelope", async () => {
    await expect(decodePoint({ nope: true }, undefined, uuid(26), resolveSdek)).rejects.toBeInstanceOf(
      UnreadableRestorePointError,
    );
  });
});

describe("validatePoint", () => {
  it("accepts a valid tree, parents first", () => {
    expect(validatePoint(point(tree))).toEqual(point(tree));
  });

  it("rejects a parent that comes later (or forms a cycle)", () => {
    const nodes: PointNode[] = [
      { o: uuid(1), k: "f", t: "A", p: uuid(2), x: "a0" },
      { o: uuid(2), k: "f", t: "B", p: uuid(1), x: "a0" },
    ];
    expect(() => validatePoint(point(nodes))).toThrow(UnreadableRestorePointError);
  });

  it("rejects a parent that does not exist", () => {
    expect(() => validatePoint(point([{ o: uuid(1), k: "f", t: "A", p: uuid(77), x: "a0" }]))).toThrow(
      UnreadableRestorePointError,
    );
  });

  it("rejects duplicate ids", () => {
    const dup = [tree[0], { ...tree[0] }];
    expect(() => validatePoint(point(dup))).toThrow(UnreadableRestorePointError);
  });

  it("rejects a node that claims a built-in root's id", () => {
    expect(() => validatePoint(point([{ o: ROOT, k: "f", t: "A", p: ROOT, x: "a0" }]))).toThrow(
      UnreadableRestorePointError,
    );
  });

  it("rejects ids that are not UUIDs", () => {
    expect(() => validatePoint(point([{ o: "not-a-uuid", k: "f", t: "A", p: ROOT, x: "a0" }]))).toThrow(
      UnreadableRestorePointError,
    );
  });

  it("rejects a URL on a folder and a bookmark without one", () => {
    expect(() => validatePoint(point([{ o: uuid(1), k: "f", t: "A", u: "https://x.test", p: ROOT, x: "a0" }]))).toThrow(
      UnreadableRestorePointError,
    );
    expect(() => validatePoint(point([{ o: uuid(1), k: "b", t: "A", p: ROOT, x: "a0" }]))).toThrow(
      UnreadableRestorePointError,
    );
  });

  it("rejects bad shapes", () => {
    expect(() => validatePoint(null)).toThrow(UnreadableRestorePointError);
    expect(() => validatePoint({ ...point(tree), kind: "bogus" })).toThrow(UnreadableRestorePointError);
    expect(() => validatePoint({ ...point(tree), nodes: "x" })).toThrow(UnreadableRestorePointError);
    expect(() => validatePoint({ ...point(tree), createdAt: "yesterday" })).toThrow(UnreadableRestorePointError);
    expect(() => validatePoint(point([{ o: uuid(1), k: "x" as never, t: "A", p: ROOT, x: "a0" }]))).toThrow(
      UnreadableRestorePointError,
    );
  });
});
