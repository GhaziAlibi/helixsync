import { afterEach, describe, expect, it } from "vitest";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import {
  activeB64ImplForTesting,
  assertSupportedEnvelopeVersion,
  buildOperationAad,
  DEFAULT_KDF_PARAMS,
  decryptPayload,
  deriveAuthKey,
  deriveKek,
  deriveMasterKey,
  ENVELOPE_VERSION,
  encryptPayload,
  fromB64,
  fromB64Fallback,
  generateAccountKey,
  getSdek,
  resetB64DetectionForTesting,
  toB64,
  toB64Fallback,
  UnsupportedEnvelopeVersionError,
  unwrapAccountKey,
  wrapAccountKey,
} from "./index";

const testAad = buildOperationAad("bookmark", "test-object-id", "create");

function randomSaltB64(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

// SEC-14: deriveMasterKey now rejects anything below DEFAULT_KDF_PARAMS, so
// tests that only care about derivation *behavior* (determinism, sensitivity
// to inputs) can no longer use a cheaper-than-default cost to speed things
// up — they use the floor itself, which is also the production default.
const FAST_KDF_PARAMS = DEFAULT_KDF_PARAMS;

describe("deriveMasterKey (Argon2id)", () => {
  it("derives the same key for the same password+salt+params", async () => {
    const salt = randomSaltB64();
    const a = await deriveMasterKey("correct horse battery staple", salt, FAST_KDF_PARAMS);
    const b = await deriveMasterKey("correct horse battery staple", salt, FAST_KDF_PARAMS);
    expect(a).toEqual(b);
  });

  it("derives a different key for a different password", async () => {
    const salt = randomSaltB64();
    const a = await deriveMasterKey("password one", salt, FAST_KDF_PARAMS);
    const b = await deriveMasterKey("password two", salt, FAST_KDF_PARAMS);
    expect(a).not.toEqual(b);
  });

  it("derives a different key for a different salt", async () => {
    const a = await deriveMasterKey("same password", randomSaltB64(), FAST_KDF_PARAMS);
    const b = await deriveMasterKey("same password", randomSaltB64(), FAST_KDF_PARAMS);
    expect(a).not.toEqual(b);
  });

  it("uses the exported DEFAULT_KDF_PARAMS for real derivations", () => {
    expect(DEFAULT_KDF_PARAMS).toEqual({ m: 19456, t: 2, p: 1 });
  });

  // SEC-14: a compromised/malicious server answers `/auth/prelogin` with
  // weak kdfParams to make offline password cracking cheap. deriveMasterKey
  // is the single choke point every caller goes through, so it must refuse
  // to run Argon2id with anything outside the decided bounds.
  it("rejects a below-floor memory cost (the SEC-14 downgrade attack)", async () => {
    const salt = randomSaltB64();
    await expect(deriveMasterKey("password", salt, { m: 8, t: 1, p: 1 })).rejects.toThrow();
  });

  it("rejects a below-floor time cost", async () => {
    const salt = randomSaltB64();
    await expect(deriveMasterKey("password", salt, { m: 19456, t: 1, p: 1 })).rejects.toThrow();
  });

  it("rejects a below-floor parallelism", async () => {
    const salt = randomSaltB64();
    await expect(deriveMasterKey("password", salt, { m: 19456, t: 2, p: 0 })).rejects.toThrow();
  });

  it("rejects an above-ceiling memory cost", async () => {
    const salt = randomSaltB64();
    await expect(deriveMasterKey("password", salt, { m: 262145, t: 2, p: 1 })).rejects.toThrow();
  });

  it("rejects an above-ceiling time cost", async () => {
    const salt = randomSaltB64();
    await expect(deriveMasterKey("password", salt, { m: 19456, t: 11, p: 1 })).rejects.toThrow();
  });

  it("rejects an above-ceiling parallelism", async () => {
    const salt = randomSaltB64();
    await expect(deriveMasterKey("password", salt, { m: 19456, t: 2, p: 5 })).rejects.toThrow();
  });

  it("rejects non-integer params", async () => {
    const salt = randomSaltB64();
    await expect(deriveMasterKey("password", salt, { m: 19456.5, t: 2, p: 1 })).rejects.toThrow();
  });

  it("rejects a salt shorter than 16 bytes", async () => {
    const shortSalt = btoa(String.fromCharCode(...new Uint8Array(8)));
    await expect(deriveMasterKey("password", shortSalt, DEFAULT_KDF_PARAMS)).rejects.toThrow();
  });

  it("rejects a salt longer than 64 bytes", async () => {
    const longSalt = btoa(String.fromCharCode(...new Uint8Array(65)));
    await expect(deriveMasterKey("password", longSalt, DEFAULT_KDF_PARAMS)).rejects.toThrow();
  });

  it("accepts params exactly at the floor (the production default)", async () => {
    const salt = randomSaltB64();
    await expect(deriveMasterKey("password", salt, { m: 19456, t: 2, p: 1 })).resolves.toBeInstanceOf(
      Uint8Array,
    );
  });
});

describe("deriveAuthKey / deriveKek", () => {
  it("derives distinct outputs from the same master key (different HKDF info)", async () => {
    const masterKey = await deriveMasterKey("test password", randomSaltB64(), FAST_KDF_PARAMS);
    const authKey = await deriveAuthKey(masterKey);
    const kek = await deriveKek(masterKey);
    expect(authKey).not.toBe(toB64(kek));
  });

  it("deriveAuthKey is deterministic for the same master key", async () => {
    const masterKey = await deriveMasterKey("test password", randomSaltB64(), FAST_KDF_PARAMS);
    const a = await deriveAuthKey(masterKey);
    const b = await deriveAuthKey(masterKey);
    expect(a).toBe(b);
  });

  it("deriveKek is deterministic for the same master key", async () => {
    const masterKey = await deriveMasterKey("test password", randomSaltB64(), FAST_KDF_PARAMS);
    const a = await deriveKek(masterKey);
    const b = await deriveKek(masterKey);
    expect(a).toEqual(b);
  });

  it("deriveAuthKey differs between different master keys", async () => {
    const salt = randomSaltB64();
    const masterKey1 = await deriveMasterKey("password one", salt, FAST_KDF_PARAMS);
    const masterKey2 = await deriveMasterKey("password two", salt, FAST_KDF_PARAMS);
    const a = await deriveAuthKey(masterKey1);
    const b = await deriveAuthKey(masterKey2);
    expect(a).not.toBe(b);
  });
});

describe("generateAccountKey / wrapAccountKey / unwrapAccountKey", () => {
  it("generateAccountKey produces 32 random bytes, different each call", () => {
    const a = generateAccountKey();
    const b = generateAccountKey();
    expect(a).toHaveLength(32);
    expect(b).toHaveLength(32);
    expect(a).not.toEqual(b);
  });

  it("round-trips an account key through wrap/unwrap under the same KEK", async () => {
    const masterKey = await deriveMasterKey("test password", randomSaltB64(), FAST_KDF_PARAMS);
    const kek = await deriveKek(masterKey);
    const accountKey = generateAccountKey();
    const wrapped = wrapAccountKey(kek, accountKey);
    const unwrapped = unwrapAccountKey(kek, wrapped);
    expect(unwrapped).toEqual(accountKey);
  });

  it("produces different wrapped output for the same account key (random nonce)", async () => {
    const masterKey = await deriveMasterKey("test password", randomSaltB64(), FAST_KDF_PARAMS);
    const kek = await deriveKek(masterKey);
    const accountKey = generateAccountKey();
    const a = wrapAccountKey(kek, accountKey);
    const b = wrapAccountKey(kek, accountKey);
    expect(a).not.toBe(b);
  });

  it("throws when unwrapping with a KEK derived from a different password", async () => {
    const salt = randomSaltB64();
    const masterKey1 = await deriveMasterKey("correct password", salt, FAST_KDF_PARAMS);
    const masterKey2 = await deriveMasterKey("wrong password", salt, FAST_KDF_PARAMS);
    const kek1 = await deriveKek(masterKey1);
    const kek2 = await deriveKek(masterKey2);
    const accountKey = generateAccountKey();
    const wrapped = wrapAccountKey(kek1, accountKey);
    expect(() => unwrapAccountKey(kek2, wrapped)).toThrow();
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
    const akB64 = toB64(generateAccountKey());
    const payload = { title: "Example", url: "https://example.com", nested: { a: 1, b: [1, 2, 3] } };
    const envelope = await encryptPayload(payload, akB64, 1, testAad);
    expect(envelope.alg).toBe("xchacha20poly1305");
    expect(envelope.keyVersion).toBe(1);
    const decrypted = await decryptPayload(envelope, akB64, testAad);
    expect(decrypted).toEqual(payload);
  });

  it("fails to decrypt with the wrong account key", async () => {
    const ak1 = toB64(generateAccountKey());
    const ak2 = toB64(generateAccountKey());
    const envelope = await encryptPayload({ a: 1 }, ak1, 1, testAad);
    await expect(decryptPayload(envelope, ak2, testAad)).rejects.toThrow();
  });

  it("produces different ciphertext for the same plaintext (random nonce)", async () => {
    const akB64 = toB64(generateAccountKey());
    const a = await encryptPayload({ x: 1 }, akB64, 1, testAad);
    const b = await encryptPayload({ x: 1 }, akB64, 1, testAad);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("derives distinct keys per keyVersion (rotation, docs/encryption.md §4)", async () => {
    const akB64 = toB64(generateAccountKey());
    const envelope = await encryptPayload({ a: 1 }, akB64, 1, testAad);
    // Decrypting a v1 envelope while claiming it's v2 must fail: the SDEK
    // derivation is keyVersion-dependent.
    await expect(decryptPayload({ ...envelope, keyVersion: 2 }, akB64, testAad)).rejects.toThrow();
  });

  it("fails to decrypt when the AAD doesn't match (F-02: metadata binding)", async () => {
    const akB64 = toB64(generateAccountKey());
    const envelope = await encryptPayload({ a: 1 }, akB64, 1, testAad);
    const wrongAad = buildOperationAad("bookmark", "test-object-id", "delete");
    await expect(decryptPayload(envelope, akB64, wrongAad)).rejects.toThrow();
  });

  // A relabelled op is a *tampered* ciphertext, not an unreadable format:
  // the engine skips the former and halts on the latter, so the two errors
  // must stay distinguishable.
  it("reports a relabelled envelope as an authentication failure, not an unsupported version", async () => {
    const akB64 = toB64(generateAccountKey());
    const envelope = await encryptPayload({ a: 1 }, akB64, 1, testAad);
    const wrongAad = buildOperationAad("tab", "test-object-id", "create");
    const err = await decryptPayload(envelope, akB64, wrongAad).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(UnsupportedEnvelopeVersionError);
  });
});

describe("envelope versioning (frozen format)", () => {
  it("stamps every AAD-bound envelope with version 2", async () => {
    const akB64 = toB64(generateAccountKey());
    const envelope = await encryptPayload({ a: 1 }, akB64, 1, testAad);
    expect(ENVELOPE_VERSION).toBe(2);
    expect(envelope.v).toBe(2);
  });

  it("leaves the account-key wrap at its own version 1", () => {
    // Different format, different version: must not follow ENVELOPE_VERSION.
    const wrapped = JSON.parse(wrapAccountKey(new Uint8Array(32).fill(7), generateAccountKey())) as { v: number };
    expect(wrapped.v).toBe(1);
  });

  // The v1 format had no AAD. Reading it would let a server relabel exactly
  // those ciphertexts, so there is no fallback: it is rejected outright.
  it("rejects a v1 envelope as unsupported, even when its ciphertext is valid", async () => {
    const akB64 = toB64(generateAccountKey());
    const envelope = await encryptPayload({ a: 1 }, akB64, 1, testAad);
    const v1 = { ...envelope, v: 1 } as unknown as Parameters<typeof decryptPayload>[0];
    const err = await decryptPayload(v1, akB64, testAad).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnsupportedEnvelopeVersionError);
    expect((err as UnsupportedEnvelopeVersionError).envelopeVersion).toBe(1);
  });

  it("does not read a real v1 (no-AAD) ciphertext", async () => {
    const akB64 = toB64(generateAccountKey());
    const sdek = await getSdek(akB64, 1);
    const nonce = crypto.getRandomValues(new Uint8Array(24));
    const ciphertext = xchacha20poly1305(sdek, nonce).encrypt(new TextEncoder().encode('{"a":1}'));
    const v1 = { v: 1, keyVersion: 1, alg: "xchacha20poly1305", nonce: toB64(nonce), ciphertext: toB64(ciphertext) };
    await expect(decryptPayload(v1 as never, akB64, testAad)).rejects.toBeInstanceOf(UnsupportedEnvelopeVersionError);
  });

  it("rejects a future version as unsupported and says to update the extension", async () => {
    const akB64 = toB64(generateAccountKey());
    const envelope = await encryptPayload({ a: 1 }, akB64, 1, testAad);
    const v3 = { ...envelope, v: 3 } as unknown as Parameters<typeof decryptPayload>[0];
    const err = (await decryptPayload(v3, akB64, testAad).catch((e: unknown) => e)) as UnsupportedEnvelopeVersionError;
    expect(err).toBeInstanceOf(UnsupportedEnvelopeVersionError);
    expect(err.envelopeVersion).toBe(3);
    expect(err.message).toMatch(/Update the HelixSync extension/);
  });

  it("treats an envelope with no numeric version as malformed, not as another format", async () => {
    const akB64 = toB64(generateAccountKey());
    const envelope = await encryptPayload({ a: 1 }, akB64, 1, testAad);
    for (const v of [undefined, "2", null]) {
      const broken = { ...envelope, v } as unknown as Parameters<typeof decryptPayload>[0];
      const err = await decryptPayload(broken, akB64, testAad).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(UnsupportedEnvelopeVersionError);
    }
  });

  it("assertSupportedEnvelopeVersion only objects to a numeric version other than 2", () => {
    expect(() => assertSupportedEnvelopeVersion({ v: 2 })).not.toThrow();
    expect(() => assertSupportedEnvelopeVersion({ v: 1 })).toThrow(UnsupportedEnvelopeVersionError);
    expect(() => assertSupportedEnvelopeVersion({ v: 7 })).toThrow(UnsupportedEnvelopeVersionError);
    for (const notAnEnvelope of [undefined, null, "text", 5, {}, { v: "1" }]) {
      expect(() => assertSupportedEnvelopeVersion(notAnEnvelope)).not.toThrow();
    }
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
  // The ~1.9MB cases are CPU-bound and take several seconds on a CI runner;
  // vitest's default 5s limit is too tight for them.
  const timeout = 30_000;

  for (const size of sizes) {
    it(`matches the reference implementation for ${size} bytes`, { timeout }, () => {
      const bytes = makeBytes(size);
      expect(toB64Fallback(bytes)).toBe(referenceToB64(bytes));
    });

    it(`round-trips ${size} bytes through toB64Fallback/fromB64Fallback unchanged`, { timeout }, () => {
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
