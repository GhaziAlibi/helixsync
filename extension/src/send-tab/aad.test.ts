import { describe, expect, it } from "vitest";
import {
  buildOperationAad,
  buildTabSendAad,
  decryptPayload,
  encryptPayload,
  generateAccountKey,
  toB64,
} from "../crypto";

const ak = toB64(generateAccountKey());
const payload = { url: "https://example.com/", sentAt: 1 };

describe("buildTabSendAad", () => {
  const aad = buildTabSendAad("id-1", "from-1", "to-1");

  it("round-trips with the same ids", async () => {
    const envelope = await encryptPayload(payload, ak, 1, aad);
    expect(await decryptPayload(envelope, ak, buildTabSendAad("id-1", "from-1", "to-1"))).toEqual(payload);
  });

  it.each([
    ["target", buildTabSendAad("id-1", "from-1", "to-2")],
    ["sender", buildTabSendAad("id-1", "from-2", "to-1")],
    ["id", buildTabSendAad("id-2", "from-1", "to-1")],
    ["swapped sender and target", buildTabSendAad("id-1", "to-1", "from-1")],
  ])("fails when the %s differs", async (_name, other) => {
    const envelope = await encryptPayload(payload, ak, 1, aad);
    await expect(decryptPayload(envelope, ak, other)).rejects.toThrow();
  });

  it("is domain-separated from a sync operation's AAD", async () => {
    const envelope = await encryptPayload(payload, ak, 1, aad);
    await expect(decryptPayload(envelope, ak, buildOperationAad("tabSend", "id-1", "from-1"))).rejects.toThrow();
    const asOperation = await encryptPayload(payload, ak, 1, buildOperationAad("tab", "id-1", "create"));
    await expect(decryptPayload(asOperation, ak, aad)).rejects.toThrow();
  });
});
