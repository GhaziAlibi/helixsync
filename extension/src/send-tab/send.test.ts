import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { buildTabSendAad, decryptPayload, generateAccountKey, toB64 } from "../crypto";

const ak = toB64(generateAccountKey());
const SELF = "self-device";
const TARGET = "target-device";

vi.mock("../storage/db", () => ({
  getDevice: vi.fn(async () => ({ deviceId: "self-device", accountKey: ak, accountKeyVersion: 1 })),
}));

const sendTabToServer = vi.fn();
const serverSupportsSendTab = vi.fn(async () => true);
vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  sendTabToServer: (...args: unknown[]) => sendTabToServer(...args),
  serverSupportsSendTab: () => serverSupportsSendTab(),
}));

const { sendTabToDevice } = await import("./send");

beforeEach(() => {
  sendTabToServer.mockReset();
  sendTabToServer.mockResolvedValue({ delivered: true });
  serverSupportsSendTab.mockResolvedValue(true);
});

describe("sendTabToDevice", () => {
  it("sends an envelope only the target can open, with the url and title inside", async () => {
    expect(await sendTabToDevice(TARGET, "https://example.com/a?b=1", "A page")).toEqual({ ok: true });

    const [targetId, body] = sendTabToServer.mock.calls[0] as [string, { id: string; envelope: never }];
    expect(targetId).toBe(TARGET);
    // Nothing readable is sent in the clear.
    expect(JSON.stringify(body)).not.toContain("example.com");

    const plaintext = (await decryptPayload(body.envelope, ak, buildTabSendAad(body.id, SELF, TARGET))) as {
      url: string;
      title: string;
      sentAt: number;
    };
    expect(plaintext.url).toBe("https://example.com/a?b=1");
    expect(plaintext.title).toBe("A page");
    expect(Math.abs(Date.now() - plaintext.sentAt)).toBeLessThan(5000);

    await expect(decryptPayload(body.envelope, ak, buildTabSendAad(body.id, SELF, "other"))).rejects.toThrow();
  });

  it("uses a fresh id each time", async () => {
    await sendTabToDevice(TARGET, "https://example.com/");
    await sendTabToDevice(TARGET, "https://example.com/");
    const ids = sendTabToServer.mock.calls.map((c) => (c[1] as { id: string }).id);
    expect(new Set(ids).size).toBe(2);
  });

  it("reports an offline target", async () => {
    sendTabToServer.mockResolvedValue({ delivered: false });
    expect(await sendTabToDevice(TARGET, "https://example.com/")).toEqual({ ok: false, reason: "offline" });
  });

  it.each(["javascript:alert(1)", "chrome://settings", "file:///x", "nope"])("refuses %s before any request", async (url) => {
    expect(await sendTabToDevice(TARGET, url)).toEqual({ ok: false, reason: "bad_url" });
    expect(sendTabToServer).not.toHaveBeenCalled();
  });

  it("refuses an address too large for one envelope", async () => {
    const result = await sendTabToDevice(TARGET, `https://example.com/${"a".repeat(7000)}`);
    expect(result).toEqual({ ok: false, reason: "too_large" });
    expect(sendTabToServer).not.toHaveBeenCalled();
  });

  it("does nothing on a server without send-tab", async () => {
    serverSupportsSendTab.mockResolvedValue(false);
    expect(await sendTabToDevice(TARGET, "https://example.com/")).toEqual({ ok: false, reason: "unsupported" });
    expect(sendTabToServer).not.toHaveBeenCalled();
  });

  it("maps server errors", async () => {
    sendTabToServer.mockRejectedValueOnce(new ApiError("gone", 404, "not_found"));
    expect(await sendTabToDevice(TARGET, "https://example.com/")).toEqual({ ok: false, reason: "device_gone" });
    sendTabToServer.mockRejectedValueOnce(new ApiError("slow down", 429, "rate_limited", 5));
    expect(await sendTabToDevice(TARGET, "https://example.com/")).toEqual({ ok: false, reason: "rate_limited" });
    sendTabToServer.mockRejectedValueOnce(new Error("boom"));
    expect(await sendTabToDevice(TARGET, "https://example.com/")).toEqual({ ok: false, reason: "failed", message: "boom" });
  });
});
