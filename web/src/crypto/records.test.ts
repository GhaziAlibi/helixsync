import { describe, expect, it } from "vitest";
import vectors from "../vault/fixtures/extension-vectors.json";
import {
  ENVELOPE_VERSION,
  UnsupportedEnvelopeVersionError,
  assertSupportedEnvelopeVersion,
  buildOperationAad,
  decryptBytesWithSdek,
  decryptWithSdek,
  fromB64,
  getSdek,
  type EncryptionEnvelope,
} from "./index";

const accountKey = fromB64(vectors.akB64);
const envelope = vectors.bookmark.envelope as EncryptionEnvelope;
const { objectType, objectId, operationType, plaintext } = vectors.bookmark;

describe("record decryption, against the extension's output", () => {
  it("decrypts an envelope the extension produced", async () => {
    const sdek = await getSdek(accountKey, envelope.keyVersion);
    const aad = buildOperationAad(objectType, objectId, operationType);
    expect(decryptWithSdek(envelope, sdek, aad)).toEqual(plaintext);
  });

  it("builds the same AAD bytes as the extension", () => {
    expect(new TextDecoder().decode(buildOperationAad("bookmark", "id-1", "create"))).toBe(
      '["bookmark","id-1","create"]',
    );
  });

  it("fails when the AAD names another object, type or operation", async () => {
    const sdek = await getSdek(accountKey, 1);
    for (const aad of [
      buildOperationAad(objectType, "another-id", operationType),
      buildOperationAad("bookmarkFolder", objectId, operationType),
      buildOperationAad(objectType, objectId, "update"),
    ]) {
      expect(() => decryptWithSdek(envelope, sdek, aad)).toThrow();
    }
  });

  it("fails under another key version's SDEK", async () => {
    const sdek2 = await getSdek(accountKey, 2);
    expect(() => decryptWithSdek(envelope, sdek2, buildOperationAad(objectType, objectId, operationType))).toThrow();
  });

  it("fails on a tampered ciphertext", async () => {
    const sdek = await getSdek(accountKey, 1);
    const bytes = fromB64(envelope.ciphertext);
    bytes[0] ^= 1;
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    const tampered = { ...envelope, ciphertext: btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") };
    expect(() => decryptBytesWithSdek(tampered, sdek, buildOperationAad(objectType, objectId, operationType))).toThrow();
  });

  it("raises the distinct error for an unsupported envelope version", async () => {
    const sdek = await getSdek(accountKey, 1);
    const future = { ...envelope, v: ENVELOPE_VERSION + 1 } as unknown as EncryptionEnvelope;
    const aad = buildOperationAad(objectType, objectId, operationType);
    expect(() => decryptBytesWithSdek(future, sdek, aad)).toThrow(UnsupportedEnvelopeVersionError);
    expect(() => assertSupportedEnvelopeVersion(future)).toThrow(UnsupportedEnvelopeVersionError);
    try {
      assertSupportedEnvelopeVersion({ v: 1 });
    } catch (err) {
      expect((err as UnsupportedEnvelopeVersionError).envelopeVersion).toBe(1);
    }
  });

  it("treats an envelope with no version as malformed, not unsupported", async () => {
    const sdek = await getSdek(accountKey, 1);
    const { v: _v, ...noVersion } = envelope;
    void _v;
    const aad = buildOperationAad(objectType, objectId, operationType);
    expect(() => assertSupportedEnvelopeVersion(noVersion)).not.toThrow();
    expect(() => decryptBytesWithSdek(noVersion as unknown as EncryptionEnvelope, sdek, aad)).toThrow(
      /malformed/,
    );
  });
});
