// The "Send to device" context menu (right-click a page or a link).
//
// A menu can't be built at click time, so the device list is cached and the
// menu rebuilt when something that changes it happens (see
// `refreshSendTabMenu`'s callers in background/index.ts). Listeners must be
// added while the worker script first runs, so `registerSendTabMenu` is
// called at top level.
import { listDevices, serverSupportsSendTab, type DeviceListEntry } from "../api/client";
import { loadTranslator } from "../i18n";
import { getDevice } from "../storage/db";
import { createKeyedLock } from "../util/keyed-lock";
import { cacheDevices, deviceName, otherDevices } from "./devices";
import { failureMessage } from "./messages";
import { sendTabToDevice } from "./send";

const PARENT_ID = "helixsync-send-tab";
const CHILD_PREFIX = `${PARENT_ID}:`;
const NOTIFICATIONS_PERMISSION: chrome.permissions.Permissions = { permissions: ["notifications"] };

const lock = createKeyedLock();

function removeAllMenus(): Promise<void> {
  return new Promise((resolve) => chrome.contextMenus.removeAll(() => resolve()));
}

function createMenu(properties: chrome.contextMenus.CreateProperties): Promise<void> {
  return new Promise((resolve) =>
    chrome.contextMenus.create(properties, () => {
      // A duplicate id or similar must not leave the rebuild hanging; the
      // next rebuild starts with removeAll anyway.
      void chrome.runtime.lastError;
      resolve();
    }),
  );
}

/** "&" starts an access key in some browsers' menus; "&&" is a literal one. */
function menuLabel(name: string): string {
  return name.replace(/&/g, "&&");
}

/** Rebuilds the menu from the account's current devices and returns them
 * (others only, with live online state). With no connected device, or a server
 * without send-tab, the menu is removed and the list is empty. A failed device
 * lookup throws and leaves the existing menu alone. */
export function refreshSendTabMenu(): Promise<DeviceListEntry[]> {
  return lock.run("menu", async () => {
    const self = await getDevice();
    if (!self || !(await serverSupportsSendTab())) {
      if (chrome.contextMenus) await removeAllMenus();
      return [];
    }
    const others = otherDevices(await listDevices(), self.deviceId);
    await cacheDevices(others);
    if (!chrome.contextMenus) return others;
    await removeAllMenus();
    if (others.length === 0) return others;

    const tr = await loadTranslator();
    await createMenu({ id: PARENT_ID, title: tr.t("sendtab_menuTitle"), contexts: ["page", "link"] });
    for (const device of others) {
      await createMenu({
        id: `${CHILD_PREFIX}${device.id}`,
        parentId: PARENT_ID,
        title: menuLabel(device.name),
        contexts: ["page", "link"],
      });
    }
    return others;
  });
}

export interface SendTabMenuHooks {
  /** Brief feedback on the toolbar button: "✓" for sent, "!" for a failure. */
  flashBadge: (text: string) => void;
}

/** Sends the clicked link, or else the page, to the chosen device and reports
 * the outcome. Exported for tests. */
export async function handleMenuClick(
  info: chrome.contextMenus.OnClickData,
  tab: chrome.tabs.Tab | undefined,
  hooks: SendTabMenuHooks,
): Promise<void> {
  const id = String(info.menuItemId);
  if (!id.startsWith(CHILD_PREFIX)) return;
  const targetId = id.slice(CHILD_PREFIX.length);

  const url = info.linkUrl ?? tab?.url ?? info.pageUrl;
  const title = info.linkUrl ? undefined : tab?.title;
  const result = url ? await sendTabToDevice(targetId, url, title) : ({ ok: false, reason: "bad_url" } as const);

  hooks.flashBadge(result.ok ? "✓" : "!");

  // A toast only with the optional permission; the badge covers the rest.
  if (!chrome.notifications || !(await chrome.permissions.contains(NOTIFICATIONS_PERMISSION))) return;
  const tr = await loadTranslator();
  const name = (await deviceName(targetId)) ?? tr.t("sendtab_unknownDevice");
  await chrome.notifications.create({
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title: "HelixSync",
    message: result.ok ? tr.t("sendtab_sent", { device: name }) : failureMessage(tr.t, result, name),
  });
}

export function registerSendTabMenu(hooks: SendTabMenuHooks): void {
  chrome.contextMenus?.onClicked.addListener((info, tab) => {
    void handleMenuClick(info, tab, hooks).catch((e) => console.error("HelixSync: send-tab click failed", e));
  });
}
