// Tabs, windows, and tab groups per docs/protocol.md §8.4/§8.5.
// Tabs/windows are device-scoped: a remote tab/window is
// always device-scoped session state, materialized as a real local browser
// tab ONLY when the user has enabled "Restore remote tabs" with an
// "automatic" policy — otherwise it's tracked for display only. This is
// what guarantees a remote tab can never destroy an unrelated local tab.
import { createLocalOperation, registerApplier } from "../sync/engine";
import { recordLocalFieldState, resolveField, resolveFields } from "../sync/conflict";
import {
  establishMapping,
  forgetMapping,
  getOrCreateObjectId,
  lookupChromiumLocalId,
  lookupObjectId,
} from "../sync/mapping";
import { getFieldState, putRemoteObject } from "../storage/db";
import { createSuppressionGuard } from "../sync/suppress";
import { tabGroupUpdateProps, tabsGroupOptions } from "./groupSync";
import { fetchSettings } from "../api/client";
import type {
  ObjectType,
  OperationOut,
  OperationType,
  TabGroupPayload,
  TabPayload,
  WindowPayload,
} from "../sync/types";

const WINDOW_TYPE: ObjectType = "window";
const TAB_TYPE: ObjectType = "tab";
const GROUP_TYPE: ObjectType = "tabGroup";

const tabGroupsSupported = typeof chrome.tabGroups !== "undefined";

// See sync/suppress.ts. `materializeTab`/`syncTabGroup` below call
// chrome.tabs.update/create/group and chrome.tabGroups.update to apply a
// remote change locally — each of those fires the matching onUpdated/
// onCreated/onGroupUpdated listener, which without this guard would emit
// a *new* operation for the same already-applied change, and the origin
// device would apply it right back (materializeTab is only reachable
// under the "automatic" restore policy, so this loop is otherwise
// unbounded between two devices that both auto-restore). The value-
// equality check in `handleTabUpdated`/`handleGroupUpdated` below is a
// second, timing-independent backstop for a tab's own multi-stage async
// loading events (see that function's comment), which this synchronous
// guard alone can't cover.
const guard = createSuppressionGuard();

function opKey(lamportTimestamp: number, deviceId: string, operationId: string, operationType: OperationType) {
  return { lamportTimestamp, deviceId, operationId, operationType };
}

async function restorePolicy(): Promise<"disabled" | "ask" | "automatic"> {
  try {
    const settings = await fetchSettings();
    return settings.tabRestorePolicy;
  } catch {
    return "disabled"; // fail closed: never auto-materialize tabs if settings are unreachable
  }
}

// --- Windows --------------------------------------------------------------

async function handleWindowCreated(win: chrome.windows.Window): Promise<void> {
  if (win.id === undefined || win.id === chrome.windows.WINDOW_ID_NONE) return;
  const objectId = await getOrCreateObjectId(WINDOW_TYPE, String(win.id));
  const payload: WindowPayload = {
    focused: win.focused,
    incognito: win.incognito,
    state: win.state,
  };
  const { operation, deviceId } = await createLocalOperation(WINDOW_TYPE, objectId, "create", payload);
  const key = opKey(operation.lamportTimestamp, deviceId, operation.operationId, "create");
  await recordLocalFieldState(objectId, "liveness", key, "live");
}

async function handleWindowRemoved(windowId: number): Promise<void> {
  const objectId = await lookupObjectId(WINDOW_TYPE, String(windowId));
  if (!objectId) return;
  const { operation, deviceId } = await createLocalOperation(WINDOW_TYPE, objectId, "close", {});
  const key = opKey(operation.lamportTimestamp, deviceId, operation.operationId, "close");
  await recordLocalFieldState(objectId, "liveness", key, "deleted");
  await forgetMapping(WINDOW_TYPE, String(windowId));
}

// --- Tabs -------------------------------------------------------------------

async function tabPayload(tab: chrome.tabs.Tab): Promise<TabPayload | undefined> {
  if (tab.id === undefined || tab.windowId === undefined || !tab.url) return undefined;
  const windowObjectId = await getOrCreateObjectId(WINDOW_TYPE, String(tab.windowId));
  let groupObjectId: string | null = null;
  if (tabGroupsSupported && tab.groupId !== undefined && tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
    groupObjectId = await getOrCreateObjectId(GROUP_TYPE, String(tab.groupId));
  }
  return {
    url: tab.url,
    title: tab.title,
    pinned: !!tab.pinned,
    index: tab.index,
    windowObjectId,
    active: !!tab.active,
    groupObjectId,
  };
}

async function handleTabCreated(tab: chrome.tabs.Tab): Promise<void> {
  if (guard.isSuppressed()) return; // our own materializeTab() chrome.tabs.create() call
  if (tab.id === undefined) return;
  const payload = await tabPayload(tab);
  if (!payload) return;
  const objectId = await getOrCreateObjectId(TAB_TYPE, String(tab.id));
  const { operation, deviceId } = await createLocalOperation(TAB_TYPE, objectId, "create", payload);
  const key = opKey(operation.lamportTimestamp, deviceId, operation.operationId, "create");
  await recordLocalFieldState(objectId, "state", key, payload);
  await recordLocalFieldState(objectId, "liveness", key, "live");
}

/** A real tab navigation/reload fires onUpdated across several async
 * stages (status: "loading" -> title/favIconUrl -> status: "complete"),
 * only the first of which (if any) falls inside `materializeTab`'s
 * synchronous `guard.run` window — the later ones arrive after the guard
 * has already reset. The value-equality check below is what actually
 * stops those from re-triggering: by the time materializeTab ran,
 * `applyTabRemote` had already resolved and stored this exact payload in
 * field_state, so any onUpdated echoing the same state (whenever it
 * arrives) is a no-op here rather than a new "update" operation — which
 * is what would otherwise ping-pong indefinitely between two devices both
 * running the "automatic" restore policy. */
async function handleTabUpdated(tabId: number, tab: chrome.tabs.Tab): Promise<void> {
  if (guard.isSuppressed()) return;
  const objectId = await lookupObjectId(TAB_TYPE, String(tabId));
  if (!objectId) return;
  const payload = await tabPayload(tab);
  if (!payload) return;
  const current = await getFieldState(objectId, "state");
  if (current && JSON.stringify(current.value) === JSON.stringify(payload)) return;
  const { operation, deviceId } = await createLocalOperation(TAB_TYPE, objectId, "update", payload);
  const key = opKey(operation.lamportTimestamp, deviceId, operation.operationId, "update");
  await recordLocalFieldState(objectId, "state", key, payload);
}

async function handleTabActivated(activeInfo: chrome.tabs.TabActiveInfo): Promise<void> {
  const objectId = await lookupObjectId(TAB_TYPE, String(activeInfo.tabId));
  if (!objectId) return;
  // Chrome can re-fire onActivated for a tab that's already the active one
  // (e.g. a window focus change) — skip the redundant operation rather
  // than uploading an identical "activate" every time.
  const current = await getFieldState(objectId, "active");
  if (current?.value === true) return;
  const { operation, deviceId } = await createLocalOperation(TAB_TYPE, objectId, "activate", {
    active: true,
  });
  const key = opKey(operation.lamportTimestamp, deviceId, operation.operationId, "activate");
  await recordLocalFieldState(objectId, "active", key, true);
}

async function handleTabRemoved(tabId: number): Promise<void> {
  const objectId = await lookupObjectId(TAB_TYPE, String(tabId));
  if (!objectId) return;
  const { operation, deviceId } = await createLocalOperation(TAB_TYPE, objectId, "close", {});
  const key = opKey(operation.lamportTimestamp, deviceId, operation.operationId, "close");
  await recordLocalFieldState(objectId, "liveness", key, "deleted");
  await forgetMapping(TAB_TYPE, String(tabId));
}

// --- Tab groups (feature-detected, docs/protocol.md §14) -------------------

/** Joins (or creates) the local Chromium tab group corresponding to a
 * remote `groupObjectId`, and applies whatever group metadata (title/
 * color/collapsed) has already been synced for it — mirroring the same
 * local-mapping pattern `TAB_TYPE`/`WINDOW_TYPE` already use
 * (`sync/mapping.ts`). Only called once a tab has actually been
 * materialized locally under the "automatic" restore policy, per
 * docs/protocol.md §8.5 ("membership reconciled via each tab's groupId").
 */
async function syncTabGroup(chromiumTabId: string, groupObjectId: string): Promise<void> {
  if (!tabGroupsSupported) return;

  const existingGroupId = await lookupChromiumLocalId(groupObjectId);
  const groupId = await guard.run(() =>
    chrome.tabs.group(tabsGroupOptions(Number(chromiumTabId), existingGroupId)),
  );
  await establishMapping(GROUP_TYPE, String(groupId), groupObjectId);

  const stored = await getFieldState(groupObjectId, "state");
  if (stored?.value) {
    await guard.run(() => chrome.tabGroups.update(groupId, tabGroupUpdateProps(stored.value as TabGroupPayload)));
  }
}

async function handleGroupUpdated(group: chrome.tabGroups.TabGroup): Promise<void> {
  if (guard.isSuppressed()) return; // our own syncTabGroup()/applyGroupRemote() chrome.tabGroups.update() call
  const objectId = await getOrCreateObjectId(GROUP_TYPE, String(group.id));
  const payload: TabGroupPayload = {
    title: group.title,
    color: group.color,
    collapsed: group.collapsed,
  };
  const current = await getFieldState(objectId, "state");
  if (current && JSON.stringify(current.value) === JSON.stringify(payload)) return;
  const { operation, deviceId } = await createLocalOperation(GROUP_TYPE, objectId, "update", payload);
  const key = opKey(operation.lamportTimestamp, deviceId, operation.operationId, "update");
  await recordLocalFieldState(objectId, "state", key, payload);
  await recordLocalFieldState(objectId, "liveness", key, "live");
}

async function handleGroupRemoved(group: chrome.tabGroups.TabGroup): Promise<void> {
  const objectId = await lookupObjectId(GROUP_TYPE, String(group.id));
  if (!objectId) return;
  const { operation, deviceId } = await createLocalOperation(GROUP_TYPE, objectId, "delete", {});
  const key = opKey(operation.lamportTimestamp, deviceId, operation.operationId, "delete");
  await recordLocalFieldState(objectId, "liveness", key, "deleted");
  await forgetMapping(GROUP_TYPE, String(group.id));
}

let captureRegistered = false;

export function registerCapture(): void {
  // See the matching guard in bookmarks/index.ts::registerCapture — called
  // on every startup and every REFRESH_CAPTURE_CONFIG message (settings
  // save), so this must stay idempotent or repeated saves register every
  // listener below multiple times.
  if (captureRegistered) return;
  captureRegistered = true;

  chrome.windows.onCreated.addListener((win) => {
    handleWindowCreated(win).catch((e) => console.error("HelixSync windows onCreated", e));
  });
  chrome.windows.onRemoved.addListener((id) => {
    handleWindowRemoved(id).catch((e) => console.error("HelixSync windows onRemoved", e));
  });

  chrome.tabs.onCreated.addListener((tab) => {
    handleTabCreated(tab).catch((e) => console.error("HelixSync tabs onCreated", e));
  });
  // Only react to the properties `tabPayload` actually reads (url, title,
  // pinned, groupId — `active`/`index` are tracked via onActivated / not
  // tracked at all, respectively). Filtered here in JS rather than via
  // chrome.tabs.onUpdated's native `filter` argument (Chrome does support
  // one at runtime, but this project's @types/chrome doesn't model it for
  // this event, so a call site passing it wouldn't type-check) — without
  // this, every transient `status`/`favIconUrl`/`audible`/`muted`/
  // `discarded` change during an ordinary page load fired the same
  // handler, each paying ~6 IndexedDB transactions (mapping lookup,
  // sequence, lamport, encrypt, enqueue, field-state) for what was usually
  // a byte-identical payload.
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (
      changeInfo.url === undefined &&
      changeInfo.title === undefined &&
      changeInfo.pinned === undefined &&
      changeInfo.groupId === undefined
    ) {
      return;
    }
    handleTabUpdated(tabId, tab).catch((e) => console.error("HelixSync tabs onUpdated", e));
  });
  chrome.tabs.onActivated.addListener((info) => {
    handleTabActivated(info).catch((e) => console.error("HelixSync tabs onActivated", e));
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    handleTabRemoved(tabId).catch((e) => console.error("HelixSync tabs onRemoved", e));
  });

  if (tabGroupsSupported) {
    chrome.tabGroups.onUpdated.addListener((group) => {
      handleGroupUpdated(group).catch((e) => console.error("HelixSync tabGroups onUpdated", e));
    });
    chrome.tabGroups.onRemoved.addListener((group) => {
      handleGroupRemoved(group).catch((e) => console.error("HelixSync tabGroups onRemoved", e));
    });
  } else {
    console.info("HelixSync: chrome.tabGroups unavailable, tab group sync disabled (feature detection)");
  }
}

// --- Remote apply ------------------------------------------------------------
// Remote tab/window state is recorded for the "tabs from
// other devices" view unconditionally, but only materialized as a real
// local browser tab when the user's tab restore policy is "automatic".
// "ask" (prompting the user interactively) is intentionally not
// auto-materialized here — surfacing the prompt is a UI-layer concern left
// to the popup, which can read `remote_objects` directly.

async function applyWindowRemote(op: OperationOut, payload: unknown): Promise<void> {
  const key = opKey(op.lamportTimestamp, op.deviceId, op.operationId, op.operationType);
  const liveValue = op.operationType === "close" ? "deleted" : "live";
  const r = await resolveField(op.objectId, "liveness", { ...key, value: liveValue });
  if (r.applied) {
    await putRemoteObject({
      objectId: op.objectId,
      objectType: WINDOW_TYPE,
      originDeviceId: op.deviceId,
      payload,
      deleted: liveValue === "deleted",
      updatedAt: op.createdAt,
    });
  }
}

async function applyTabRemote(op: OperationOut, payload: unknown): Promise<void> {
  const key = opKey(op.lamportTimestamp, op.deviceId, op.operationId, op.operationType);

  if (op.operationType === "close") {
    const r = await resolveField(op.objectId, "liveness", { ...key, value: "deleted" });
    if (r.applied) {
      await putRemoteObject({
        objectId: op.objectId,
        objectType: TAB_TYPE,
        originDeviceId: op.deviceId,
        payload: null,
        deleted: true,
        updatedAt: op.createdAt,
      });
      const chromiumId = await lookupChromiumLocalId(op.objectId);
      if (chromiumId) await forgetMapping(TAB_TYPE, chromiumId);
    }
    return;
  }

  if (op.operationType === "activate") {
    await resolveField(op.objectId, "active", { ...key, value: true });
    return;
  }

  // create / update
  const [stateResult, liveness] = await resolveFields(op.objectId, [
    { field: "state", incoming: { ...key, value: payload } },
    { field: "liveness", incoming: { ...key, value: "live" } },
  ]);
  if (!stateResult.applied) return;

  await putRemoteObject({
    objectId: op.objectId,
    objectType: TAB_TYPE,
    originDeviceId: op.deviceId,
    payload: stateResult.value,
    deleted: liveness.value === "deleted",
    updatedAt: op.createdAt,
  });

  if (liveness.value !== "live") return;

  const policy = await restorePolicy();
  if (policy !== "automatic") return;

  await materializeTab(op.objectId, stateResult.value as TabPayload);
}

/** Materializes a remote tab as a real local browser tab (creating it, or
 * updating one already materialized) and joins its tab group if any.
 * Called automatically from `applyTabRemote` under the "automatic" restore
 * policy, and directly by `restoreTab` for the "ask" policy's per-item
 * "Restore" action (`popup/main.ts` via the `RESTORE_TAB` message) — both
 * paths must materialize identically, so this is the single shared path.
 */
async function materializeTab(objectId: string, p: TabPayload): Promise<void> {
  const existingChromiumId = await lookupChromiumLocalId(objectId);
  let chromiumId: string | undefined = existingChromiumId;
  if (existingChromiumId) {
    await guard.run(() =>
      chrome.tabs.update(existingChromiumId as unknown as number, { url: p.url, pinned: p.pinned }),
    );
  } else {
    const created = await guard.run(() => chrome.tabs.create({ url: p.url, pinned: p.pinned, active: false }));
    if (created.id !== undefined) {
      chromiumId = String(created.id);
      await establishMapping(TAB_TYPE, chromiumId, objectId);
    }
  }

  if (chromiumId && p.groupObjectId) {
    await syncTabGroup(chromiumId, p.groupObjectId);
  }
}

/** Restores one remote tab tracked under the "ask" policy on explicit user
 * action (popup "Restore" button) — reuses the exact same materialization
 * path `applyTabRemote` uses under "automatic", just triggered manually
 * instead of automatically. Reads the tab's already-resolved field state
 * (recorded by `applyTabRemote` regardless of policy) rather than
 * requiring the caller to pass a payload. */
export async function restoreTab(objectId: string): Promise<void> {
  const stored = await getFieldState(objectId, "state");
  if (!stored?.value) return;
  await materializeTab(objectId, stored.value as TabPayload);
}

async function applyGroupRemote(op: OperationOut, payload: unknown): Promise<void> {
  const key = opKey(op.lamportTimestamp, op.deviceId, op.operationId, op.operationType);
  if (op.operationType === "delete") {
    const r = await resolveField(op.objectId, "liveness", { ...key, value: "deleted" });
    if (r.applied) {
      await putRemoteObject({
        objectId: op.objectId,
        objectType: GROUP_TYPE,
        originDeviceId: op.deviceId,
        payload: null,
        deleted: true,
        updatedAt: op.createdAt,
      });
    }
    return;
  }

  const [stateResult] = await resolveFields(op.objectId, [
    { field: "state", incoming: { ...key, value: payload } },
    { field: "liveness", incoming: { ...key, value: "live" } },
  ]);
  if (!stateResult.applied) return;

  await putRemoteObject({
    objectId: op.objectId,
    objectType: GROUP_TYPE,
    originDeviceId: op.deviceId,
    payload: stateResult.value,
    deleted: false,
    updatedAt: op.createdAt,
  });

  // Group membership itself is materialized from the tab side
  // (`syncTabGroup`, called from `applyTabRemote`) once a member tab is
  // actually restored locally under the "automatic" policy — a group with
  // no restored tabs has nothing to create locally. But if the local
  // Chromium group already exists (a tab arrived and joined/created it
  // before this metadata update did), apply the new title/color/collapsed
  // immediately rather than waiting for another tab event.
  if (tabGroupsSupported) {
    const existingGroupId = await lookupChromiumLocalId(op.objectId);
    if (existingGroupId !== undefined) {
      await guard.run(() =>
        chrome.tabGroups.update(Number(existingGroupId), tabGroupUpdateProps(stateResult.value as TabGroupPayload)),
      );
    }
  }
}

registerApplier(WINDOW_TYPE, applyWindowRemote);
registerApplier(TAB_TYPE, applyTabRemote);
registerApplier(GROUP_TYPE, applyGroupRemote);
