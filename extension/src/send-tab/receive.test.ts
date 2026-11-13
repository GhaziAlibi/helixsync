import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTabSendAad, encryptPayload, generateAccountKey, toB64 } from "../crypto";

const SELF = "self-device";
const SENDER = "sender-device";
const ak = toB64(generateAccountKey());

const sessionStore = new Map<string, unknown>();
const tabsCreate = vi.fn(async () => ({}));
const notificationsCreate = vi.fn(async () => "n");
const permissionsContains = vi.fn(async () => false);

vi.stubGlobal("chrome", {
  storage: {
    session: {
      get: vi.fn(async (key: string) => ({ [key]: sessionStore.get(key) })),
      set: vi.fn(async (obj: Record<string, unknown>) => void Object.entries(obj).forEach(([k, v]) => sessionStore.set(k, v))),
    },
    local: { get: vi.fn(async () => ({})) },
  },
  tabs: { create: tabsCreate },
  notifications: { create: notificationsCreate },
  permissions: { contains: permissionsContains },
  runtime: { getURL: (p: string) => `chrome-extension://x/${p}` },
  i18n: { getUILanguage: () => "en" },
});

let device: { deviceId: string; accountKey: string; accountKeyVersion: number } | undefined;
vi.mock("../storage/db", () => ({ getDevice: vi.fn(async () => device) }));
vi.mock("../api/client", () => ({ listDevices: vi.fn(async () => [{ id: SENDER, name: "Laptop" }]) }));
vi.mock("../i18n", () => ({
  loadTranslator: async () => ({ t: (key: string, params?: { device?: string }) => `${key}:${params?.device ?? ""}` }),
}));

const { handleTabSend, resetReceiveQueueForTesting } = await import("./receive");

async function frame(
  over: { id?: string; from?: string; to?: string; payload?: unknown; aadId?: string } = {},
) {
  const id = over.id ?? crypto.randomUUID();
  const from = over.from ?? SENDER;
  const payload = over.payload ?? { url: "https://example.com/page", title: "Example", sentAt: Date.now() };
  const envelope = await encryptPayload(payload, ak, 1, buildTabSendAad(over.aadId ?? id, from, over.to ?? SELF));
  return { id, fromDeviceId: from, envelope };
}

beforeEach(() => {
  sessionStore.clear();
  resetReceiveQueueForTesting();
  tabsCreate.mockClear();
  notificationsCreate.mockClear();
  permissionsContains.mockReset();
  permissionsContains.mockResolvedValue(false);
  device = { deviceId: SELF, accountKey: ak, accountKeyVersion: 1 };
});

describe("handleTabSend", () => {
  it("opens an active tab for a valid frame", async () => {
    expect(await handleTabSend(await frame())).toBe("opened");
    expect(tabsCreate).toHaveBeenCalledWith({ url: "https://example.com/page", active: true });
  });

  it("does nothing without a connected device", async () => {
    device = undefined;
    expect(await handleTabSend(await frame())).toBe("no_device");
    expect(tabsCreate).not.toHaveBeenCalled();
  });

  it("drops a replayed id, including two racing copies", async () => {
    const f = await frame();
    const [a, b] = await Promise.all([handleTabSend(f), handleTabSend(f)]);
    expect([a, b].sort()).toEqual(["opened", "replayed"]);
    expect(await handleTabSend(f)).toBe("replayed");
    expect(tabsCreate).toHaveBeenCalledTimes(1);
  });

  it("drops a frame whose sentAt is older than 10 minutes", async () => {
    const f = await frame({ payload: { url: "https://example.com/", sentAt: Date.now() - 10 * 60_000 - 1000 } });
    expect(await handleTabSend(f)).toBe("stale");
    expect(tabsCreate).not.toHaveBeenCalled();
  });

  it.each(["javascript:alert(1)", "file:///etc/passwd", "chrome://settings", "data:text/html,x", "not a url"])(
    "rejects %s",
    async (url) => {
      expect(await handleTabSend(await frame({ payload: { url, sentAt: Date.now() } }))).toBe("bad_url");
      expect(tabsCreate).not.toHaveBeenCalled();
    },
  );

  it("drops a rejected frame's id too, so it can't be replayed", async () => {
    const f = await frame({ payload: { url: "javascript:alert(1)", sentAt: Date.now() } });
    expect(await handleTabSend(f)).toBe("bad_url");
    expect(await handleTabSend(f)).toBe("replayed");
  });

  it("drops frames meant for another device, from another sender, or under another id", async () => {
    expect(await handleTabSend(await frame({ to: "someone-else" }))).toBe("undecryptable");
    const wrongSender = { ...(await frame()), fromDeviceId: "relabelled" };
    expect(await handleTabSend(wrongSender)).toBe("undecryptable");
    expect(await handleTabSend(await frame({ aadId: "other-id" }))).toBe("undecryptable");
    expect(tabsCreate).not.toHaveBeenCalled();
  });

  it("drops an envelope of an unsupported version", async () => {
    const f = await frame();
    expect(await handleTabSend({ ...f, envelope: { ...(f.envelope as object), v: 99 } })).toBe("undecryptable");
  });

  it("drops a payload of the wrong shape", async () => {
    expect(await handleTabSend(await frame({ payload: { url: 5, sentAt: Date.now() } }))).toBe("malformed");
    expect(await handleTabSend(await frame({ payload: { url: "https://a.test/" } }))).toBe("malformed");
    expect(await handleTabSend(await frame({ payload: "https://a.test/" }))).toBe("malformed");
  });

  it("opens at most 10 tabs a minute", async () => {
    for (let i = 0; i < 10; i++) expect(await handleTabSend(await frame())).toBe("opened");
    expect(await handleTabSend(await frame())).toBe("throttled");
    expect(tabsCreate).toHaveBeenCalledTimes(10);
  });

  it("opens again once the minute has passed", async () => {
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 10; i++) expect(await handleTabSend(await frame())).toBe("opened");
      expect(await handleTabSend(await frame())).toBe("throttled");
      vi.advanceTimersByTime(61_000);
      expect(await handleTabSend(await frame())).toBe("opened");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a notification only with the optional permission", async () => {
    await handleTabSend(await frame());
    await vi.waitFor(() => expect(permissionsContains).toHaveBeenCalled());
    expect(notificationsCreate).not.toHaveBeenCalled();

    permissionsContains.mockResolvedValue(true);
    await handleTabSend(await frame());
    await vi.waitFor(() => expect(notificationsCreate).toHaveBeenCalledTimes(1));
    expect(notificationsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ title: "sendtab_notifReceived:Laptop", message: "Example" }),
    );
  });
});
