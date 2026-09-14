import { describe, expect, it } from "vitest";
import { decryptPayload, deriveRekFromPassword, encryptPayload } from "./index";

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
