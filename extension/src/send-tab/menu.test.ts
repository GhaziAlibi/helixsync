import { beforeEach, describe, expect, it, vi } from "vitest";

type Created = { id: string; parentId?: string; title: string; contexts: string[] };
let created: Created[] = [];
const removeAll = vi.fn((cb: () => void) => {
  created = [];
  cb();
});
const create = vi.fn((props: Created, cb: () => void) => {
  created.push(props);
  cb();
});

vi.stubGlobal("chrome", {
  contextMenus: { removeAll, create, onClicked: { addListener: vi.fn() } },
  runtime: { lastError: undefined, getURL: (p: string) => p },
  storage: { session: { set: vi.fn(async () => {}), get: vi.fn(async () => ({})) } },
  permissions: { contains: vi.fn(async () => false) },
});

let device: { deviceId: string } | undefined = { deviceId: "self" };
vi.mock("../storage/db", () => ({ getDevice: vi.fn(async () => device) }));
vi.mock("../i18n", () => ({ loadTranslator: async () => ({ t: (k: string) => k }) }));

const listDevices = vi.fn();
const serverSupportsSendTab = vi.fn(async () => true);
vi.mock("../api/client", () => ({
  listDevices: () => listDevices(),
  serverSupportsSendTab: () => serverSupportsSendTab(),
}));

const sendTabToDevice = vi.fn();
vi.mock("./send", () => ({ sendTabToDevice: (...a: unknown[]) => sendTabToDevice(...a) }));

const { refreshSendTabMenu, handleMenuClick } = await import("./menu");

beforeEach(() => {
  created = [];
  device = { deviceId: "self" };
  serverSupportsSendTab.mockResolvedValue(true);
  listDevices.mockReset();
  sendTabToDevice.mockReset();
  sendTabToDevice.mockResolvedValue({ ok: true });
  removeAll.mockClear();
});

describe("refreshSendTabMenu", () => {
  it("builds one child per other non-revoked device, online or not", async () => {
    listDevices.mockResolvedValue([
      { id: "self", name: "This one", online: true },
      { id: "a", name: "Phone & Tablet", online: true },
      { id: "b", name: "Desktop", online: false },
      { id: "c", name: "Old", revokedAt: "2026-01-01T00:00:00Z" },
    ]);
    const others = await refreshSendTabMenu();
    expect(others.map((d) => d.id)).toEqual(["a", "b"]);
    expect(created.map((m) => [m.id, m.parentId, m.title])).toEqual([
      ["helixsync-send-tab", undefined, "sendtab_menuTitle"],
      ["helixsync-send-tab:a", "helixsync-send-tab", "Phone && Tablet"],
      ["helixsync-send-tab:b", "helixsync-send-tab", "Desktop"],
    ]);
    expect(created.every((m) => m.contexts.join() === "page,link")).toBe(true);
  });

  it("builds no menu when there are no other devices", async () => {
    listDevices.mockResolvedValue([{ id: "self", name: "Me" }]);
    expect(await refreshSendTabMenu()).toEqual([]);
    expect(created).toEqual([]);
  });

  it("removes the menu without a device or on a server without send-tab", async () => {
    device = undefined;
    expect(await refreshSendTabMenu()).toEqual([]);
    expect(removeAll).toHaveBeenCalledTimes(1);
    device = { deviceId: "self" };
    serverSupportsSendTab.mockResolvedValue(false);
    await refreshSendTabMenu();
    expect(removeAll).toHaveBeenCalledTimes(2);
    expect(listDevices).not.toHaveBeenCalled();
  });

  it("keeps the existing menu when the lookup fails", async () => {
    listDevices.mockRejectedValue(new Error("offline"));
    await expect(refreshSendTabMenu()).rejects.toThrow("offline");
    expect(removeAll).not.toHaveBeenCalled();
  });
});

describe("handleMenuClick", () => {
  const hooks = { flashBadge: vi.fn() };
  beforeEach(() => hooks.flashBadge.mockClear());

  it("sends the link when one was clicked, with no title", async () => {
    await handleMenuClick(
      { menuItemId: "helixsync-send-tab:a", linkUrl: "https://link.test/", pageUrl: "https://page.test/" } as never,
      { url: "https://page.test/", title: "Page" } as never,
      hooks,
    );
    expect(sendTabToDevice).toHaveBeenCalledWith("a", "https://link.test/", undefined);
    expect(hooks.flashBadge).toHaveBeenCalledWith("✓");
  });

  it("sends the page with its title otherwise", async () => {
    await handleMenuClick(
      { menuItemId: "helixsync-send-tab:a", pageUrl: "https://page.test/" } as never,
      { url: "https://page.test/", title: "Page" } as never,
      hooks,
    );
    expect(sendTabToDevice).toHaveBeenCalledWith("a", "https://page.test/", "Page");
  });

  it("flashes a failure and ignores other menu items", async () => {
    sendTabToDevice.mockResolvedValue({ ok: false, reason: "offline" });
    await handleMenuClick({ menuItemId: "helixsync-send-tab:a", pageUrl: "https://page.test/" } as never, undefined, hooks);
    expect(hooks.flashBadge).toHaveBeenCalledWith("!");

    sendTabToDevice.mockClear();
    await handleMenuClick({ menuItemId: "something-else" } as never, undefined, hooks);
    expect(sendTabToDevice).not.toHaveBeenCalled();
  });
});
