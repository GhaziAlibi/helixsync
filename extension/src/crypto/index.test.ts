import { afterEach, describe, expect, it } from "vitest";
import {
  activeB64ImplForTesting,
  decryptPayload,
  deriveRekFromPassword,
  encryptPayload,
  fromB64,
  fromB64Fallback,
  resetB64DetectionForTesting,
  toB64,
  toB64Fallback,
} from "./index";

function randomSaltB64(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

describe("password-derived encryption root key", () => {
  it("derives the same key for the same password+salt", async () => {
    const salt = randomSaltB64();
    const a = await deriveRekFromPassword("correct horse battery staple", salt);
    const b = await deriveRekFromPassword("correct horse battery staple", salt);
    expect(a).toBe(b);
  });

  it("derives a different key for a different password", async () => {
    const salt = randomSaltB64();
    const a = await deriveRekFromPassword("password one", salt);
    const b = await deriveRekFromPassword("password two", salt);
    expect(a).not.toBe(b);
  });

  it("derives a different key for a different salt", async () => {
    const a = await deriveRekFromPassword("same password", randomSaltB64());
    const b = await deriveRekFromPassword("same password", randomSaltB64());
    expect(a).not.toBe(b);
  });
});

// Ground truth for toB64: the original per-byte String.fromCharCode loop
// this module used before it was rewritten to chunk via
// String.fromCharCode(...chunk) for large-payload performance (EXT-PERF-3).
// Kept here (not in src) purely as an independent reference implementation.
function referenceToB64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function makeBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  // Deterministic but non-constant fill so a wrong byte offset/ordering
  // bug would actually change the output (all-zero input wouldn't).
  for (let i = 0; i < length; i++) bytes[i] = (i * 31 + 7) % 256;
  return bytes;
}

describe("toB64 chunked encoding matches the naive per-byte reference", () => {
  // 8192 is the chunk size toB64 batches String.fromCharCode(...) calls in
  // (see B64_CHUNK_SIZE in src/crypto/index.ts). Exercise both sides of
  // that boundary plus empty/small/large inputs.
  const sizes = [0, 1, 8191, 8192, 8193, 50000];

  for (const size of sizes) {
    it(`produces identical base64 to the reference implementation for ${size} bytes`, () => {
      const bytes = makeBytes(size);
      expect(toB64(bytes)).toBe(referenceToB64(bytes));
    });

    it(`round-trips ${size} bytes through toB64/fromB64 unchanged`, () => {
      const bytes = makeBytes(size);
      const decoded = fromB64(toB64(bytes));
      expect(decoded).toEqual(bytes);
    });
  }
});

describe("payload envelope encryption", () => {
  it("round-trips a JSON payload", async () => {
    const rek = await deriveRekFromPassword("test password", randomSaltB64());
    const payload = { title: "Example", url: "https://example.com", nested: { a: 1, b: [1, 2, 3] } };
    const envelope = await encryptPayload(payload, rek, 1);
    expect(envelope.alg).toBe("xchacha20poly1305");
    expect(envelope.keyVersion).toBe(1);
    const decrypted = await decryptPayload(envelope, rek);
    expect(decrypted).toEqual(payload);
  });

  it("fails to decrypt with the wrong root key", async () => {
    const rek1 = await deriveRekFromPassword("password one", randomSaltB64());
    const rek2 = await deriveRekFromPassword("password two", randomSaltB64());
    const envelope = await encryptPayload({ a: 1 }, rek1, 1);
    await expect(decryptPayload(envelope, rek2)).rejects.toThrow();
  });

  it("produces different ciphertext for the same plaintext (random nonce)", async () => {
    const rek = await deriveRekFromPassword("test password", randomSaltB64());
    const a = await encryptPayload({ x: 1 }, rek, 1);
    const b = await encryptPayload({ x: 1 }, rek, 1);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("derives distinct keys per keyVersion (rotation, docs/encryption.md §4)", async () => {
    const rek = await deriveRekFromPassword("test password", randomSaltB64());
    const envelope = await encryptPayload({ a: 1 }, rek, 1);
    // Decrypting a v1 envelope while claiming it's v2 must fail: the SDEK
    // derivation is keyVersion-dependent.
    await expect(decryptPayload({ ...envelope, keyVersion: 2 }, rek)).rejects.toThrow();
  });
});

// --- Native base64 dispatch (spec §A / §3.2) --------------------------
//
// Neither node 20 (CI) nor node 22 (local dev) implements
// Uint8Array.prototype.toBase64/fromBase64, so the feature-detect inside
// useNative() is always false when these tests run for real — the native
// branch is only exercised here via an installed polyfill. That's why the
// non-conforming-polyfill test below matters most: it's the one proof that
// a bogus/missing-option native implementation can never silently corrupt
// output, since the real Chromium behavior can't be asserted in CI at all.
afterEach(() => {
  delete (Uint8Array.prototype as { toBase64?: unknown }).toBase64;
  delete (Uint8Array as unknown as { fromBase64?: unknown }).fromBase64;
  resetB64DetectionForTesting();
});

// Verbatim copy of the vectors in src/crypto/index.ts's
// B64_CONFORMANCE_VECTORS — computed with referenceToB64 above and known
// correct. Duplicated here (not imported) so this file, like referenceToB64
// itself, stays an independent check on the source rather than testing the
// source against its own constants.
const B64_CONFORMANCE_VECTORS: ReadonlyArray<readonly [number[], string]> = [
  [[], ""],
  [[0x00], "AA"],
  [[0x00, 0x00], "AAA"],
  [[0x00, 0x00, 0x00], "AAAA"],
  [[0xfb, 0xef, 0xbe], "----"],
  [[0xff, 0xff, 0xff], "____"],
  [[0x48, 0x65, 0x6c, 0x69, 0x78, 0x53, 0x79, 0x6e, 0x63], "SGVsaXhTeW5j"],
  [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], "AAECAwQFBgcICQoLDA0ODw"],
  [
    [0xf0, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa, 0xfb, 0xfc, 0xfd, 0xfe, 0xff],
    "8PHy8_T19vf4-fr7_P3-_w",
  ],
];

function referenceFromB64(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const withPadding = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(withPadding);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

describe("toB64Fallback conformance", () => {
  // 255 (arbitrary mid-size) and the chunk-boundary trio (8191/8192/8193)
  // plus a ~1.9MB buffer matching the measured bulk-import segment size.
  const sizes = [0, 1, 255, 8191, 8192, 8193, 1_900_000];

  for (const size of sizes) {
    it(`matches the reference implementation for ${size} bytes`, () => {
      const bytes = makeBytes(size);
      expect(toB64Fallback(bytes)).toBe(referenceToB64(bytes));
    });

    it(`round-trips ${size} bytes through toB64Fallback/fromB64Fallback unchanged`, () => {
      const bytes = makeBytes(size);
      expect(fromB64Fallback(toB64Fallback(bytes))).toEqual(bytes);
    });
  }
});

describe("base64 conformance vectors", () => {
  for (const [bytes, expected] of B64_CONFORMANCE_VECTORS) {
    it(`toB64Fallback([${bytes.join(",")}]) === "${expected}"`, () => {
      expect(toB64Fallback(Uint8Array.from(bytes))).toBe(expected);
    });

    it(`fromB64Fallback("${expected}") inverts to [${bytes.join(",")}]`, () => {
      expect(fromB64Fallback(expected)).toEqual(Uint8Array.from(bytes));
    });
  }
});

describe("native base64 self-check dispatch", () => {
  it("selects native when a conforming polyfill is installed", () => {
    (Uint8Array.prototype as unknown as { toBase64: (o: unknown) => string }).toBase64 = function (
      this: Uint8Array,
    ) {
      return referenceToB64(this);
    };
    (Uint8Array as unknown as { fromBase64: (s: string) => Uint8Array }).fromBase64 = (s: string) =>
      referenceFromB64(s);
    resetB64DetectionForTesting();

    expect(activeB64ImplForTesting()).toBe("native");
    const bytes = makeBytes(12345);
    expect(toB64(bytes)).toBe(referenceToB64(bytes));
    expect(fromB64(toB64(bytes))).toEqual(bytes);
  });

  // This is the test that proves the safety net: a native implementation
  // that silently ignores the alphabet/padding options (standard padded
  // base64 instead of base64url) must never reach production output.
  it("rejects a non-conforming polyfill and stays correct via fallback", () => {
    (Uint8Array.prototype as unknown as { toBase64: () => string }).toBase64 = function (this: Uint8Array) {
      let binary = "";
      for (const b of this) binary += String.fromCharCode(b);
      return btoa(binary); // standard alphabet, padded — wrong on purpose
    };
    (Uint8Array as unknown as { fromBase64: (s: string) => Uint8Array }).fromBase64 = () =>
      new Uint8Array([1, 2, 3]); // also wrong; must never be reached
    resetB64DetectionForTesting();

    expect(activeB64ImplForTesting()).toBe("fallback");
    const bytes = makeBytes(300);
    const encoded = toB64(bytes);
    expect(encoded).toBe(referenceToB64(bytes));
    expect(encoded).not.toMatch(/[+/=]/);
    expect(fromB64(encoded)).toEqual(bytes);
  });

  it("rejects a throwing polyfill without an exception escaping toB64", () => {
    (Uint8Array.prototype as unknown as { toBase64: () => string }).toBase64 = () => {
      throw new Error("simulated native failure");
    };
    (Uint8Array as unknown as { fromBase64: (s: string) => Uint8Array }).fromBase64 = () => {
      throw new Error("simulated native failure");
    };
    resetB64DetectionForTesting();

    expect(activeB64ImplForTesting()).toBe("fallback");
    const bytes = makeBytes(300);
    expect(() => toB64(bytes)).not.toThrow();
    expect(toB64(bytes)).toBe(referenceToB64(bytes));
  });

  it("never emits +, / or = on either path", () => {
    // Fallback path (no polyfill installed).
    const fallbackEncoded = toB64(makeBytes(10_000));
    expect(fallbackEncoded).not.toMatch(/[+/=]/);

    // Native path via conforming polyfill.
    (Uint8Array.prototype as unknown as { toBase64: (o: unknown) => string }).toBase64 = function (
      this: Uint8Array,
    ) {
      return referenceToB64(this);
    };
    (Uint8Array as unknown as { fromBase64: (s: string) => Uint8Array }).fromBase64 = (s: string) =>
      referenceFromB64(s);
    resetB64DetectionForTesting();
    const nativeEncoded = toB64(makeBytes(10_000));
    expect(nativeEncoded).not.toMatch(/[+/=]/);
  });

  it("fromB64 accepts both padded and unpadded input on the fallback path", () => {
    const bytes = makeBytes(37); // arbitrary length that needs padding
    const unpadded = toB64Fallback(bytes);
    const standard = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_");
    expect(standard.endsWith("=")).toBe(true); // sanity: this input does pad
    expect(fromB64(unpadded)).toEqual(bytes);
    expect(fromB64(standard)).toEqual(bytes);
  });
});
