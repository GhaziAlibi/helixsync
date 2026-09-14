import { describe, expect, it } from "vitest";
import { decryptPayload, deriveRekFromPassword, encryptPayload, fromB64, toB64 } from "./index";

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
