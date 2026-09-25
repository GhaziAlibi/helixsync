// Tabs, windows, and tab groups per docs/protocol.md §8.4/§8.5.
// Tabs/windows are device-scoped: a remote tab/window is
// always device-scoped session state, materialized as a real local browser
// tab ONLY when the user has enabled "Restore remote tabs" with an
// "automatic" policy — otherwise it's tracked for display only. This is
// what guarantees a remote tab can never destroy an unrelated local tab.
import {
  createLocalOperationsBatch,
  registerApplier,
  registerBatchApplier,
  scheduleLocalSync,
} from "../sync/engine";
import type { PendingLocalOperation } from "../sync/engine";
import {
  recordLocalFieldState,
  recordLocalFieldStatesBatch,
  resolveField,
  resolveFields,
  resolveFieldsBatch,
  type BatchFieldResolution,
  type LocalFieldStateEntry,
} from "../sync/conflict";
import {
  establishMapping,
  forgetMapping,
  getOrCreateObjectId,
  lookupChromiumLocalId,
  lookupObjectId,
} from "../sync/mapping";
import {
  deleteMappingsBatch,
  getFieldState,
  getFieldStatesForObjects,
  getMappingsByLocalIds,
  getMappingsByObjectIds,
  putRemoteObject,
  putRemoteObjectsBatch,
} from "../storage/db";
import type { ObjectMappingRecord, RemoteObjectRecord } from "../storage/db";
import { createMicroBatchQueue } from "../sync/micro-batch";
import { createSuppressionGuard } from "../sync/suppress";
import { tabGroupUpdateProps, tabsGroupOptions } from "./groupSync";
import { fetchSettings, fetchTabRestorePolicy } from "../api/client";
import { createKeyedLock } from "../util/keyed-lock";
import type {
  ObjectType,
  OperationOut,
  OperationType,
  TabGroupPayload,
  TabPayload,
  WindowPayload,
} from "../sync/types";
import { chunk } from "../util/chunk";
import { yieldToEventLoop } from "../util/yield";

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
// equality check in `stageTabUpdated`/`stageGroupUpdated` below is a
// second, timing-independent backstop for a tab's own multi-stage async
// loading events (see that function's comment), which this synchronous
// guard alone can't cover.
const guard = createSuppressionGuard();

// Serializes syncTabGroup calls per `groupObjectId`: RESTORE_ALL_TABS
// (background/index.ts) restores several tabs concurrently, and if two of
// them belong to the same remote group, without this they'd both read
// `lookupChromiumLocalId` before either had created the group, race to
// each create their own Chromium tab group via `chrome.tabs.group`, and
// stomp each other's `establishMapping` call. Locking per key rather than
// globally means unrelated groups still materialize fully in parallel.
const groupSyncLock = createKeyedLock();

function opKey(lamportTimestamp: number, deviceId: string, operationId: string, operationType: OperationType) {
  return { lamportTimestamp, deviceId, operationId, operationType };
}

/** Per-flush memo of Chromium-local id -> HelixSync objectId, seeded up
 * front by `prefetchTabFlushCaches` so a burst of events sharing the same
 * window/group/tab (bulk import, window restore) doesn't pay one IndexedDB
 * transaction per event for the same answer. Mirrors bookmarks/index.ts's
 * `mappingCache` (EXT-04 there), which this module previously lacked: every
 * staged event used to do a mapping lookup plus up to two window/group
 * get-or-creates, all sequential. */
interface TabFlushCaches {
  tab: Map<string, string>;
  window: Map<string, string>;
  group: Map<string, string>;
}

async function cachedLookupObjectId(
  objectType: ObjectType,
  chromiumLocalId: string,
  cache: Map<string, string>,
): Promise<string | undefined> {
  const hit = cache.get(chromiumLocalId);
  if (hit) return hit;
  const found = await lookupObjectId(objectType, chromiumLocalId);
  if (found) cache.set(chromiumLocalId, found);
  return found;
}

async function cachedGetOrCreateObjectId(
  objectType: ObjectType,
  chromiumLocalId: string,
  cache: Map<string, string>,
): Promise<string> {
  const hit = cache.get(chromiumLocalId);
  if (hit) return hit;
  const objectId = await getOrCreateObjectId(objectType, chromiumLocalId);
  cache.set(chromiumLocalId, objectId);
  return objectId;
}

/** Immediate mapping drop on remove (see stageTabRemoved), kept in lockstep
 * with the per-flush cache so a later event in the same burst never reuses
 * a just-deleted entry. */
async function cachedForgetMapping(
  objectType: ObjectType,
  chromiumLocalId: string,
  cache: Map<string, string>,
): Promise<void> {
  cache.delete(chromiumLocalId);
  await forgetMapping(objectType, chromiumLocalId);
}

/** Batch prefetch backing `TabFlushCaches`: one `getMappingsByLocalIds`
 * transaction per object type covering every Chromium id referenced anywhere
 * in the burst, instead of one lookup transaction per staged event. Events
 * for ids created mid-burst still fall back to the per-event mapping calls
 * via the `cached*` helpers above, which populate the cache as they go. */
async function prefetchTabFlushCaches(events: QueuedTabEvent[]): Promise<TabFlushCaches> {
  const tabIds = new Set<string>();
  const windowIds = new Set<string>();
  const groupIds = new Set<string>();
  const collectTabRef = (tab: chrome.tabs.Tab) => {
    if (tab.id !== undefined) tabIds.add(String(tab.id));
    if (tab.windowId !== undefined) windowIds.add(String(tab.windowId));
    if (
      tabGroupsSupported &&
      tab.groupId !== undefined &&
      tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE
    ) {
      groupIds.add(String(tab.groupId));
    }
  };
  for (const event of events) {
    switch (event.kind) {
      case "tabCreated":
        collectTabRef(event.tab);
        break;
      case "tabUpdated":
        tabIds.add(String(event.tabId));
        collectTabRef(event.tab);
        break;
      case "tabActivated":
        tabIds.add(String(event.activeInfo.tabId));
        break;
      case "tabRemoved":
        tabIds.add(String(event.tabId));
        break;
      case "windowCreated":
        if (event.win.id !== undefined) windowIds.add(String(event.win.id));
        break;
      case "windowRemoved":
        windowIds.add(String(event.windowId));
        break;
      case "groupUpdated":
      case "groupRemoved":
        groupIds.add(String(event.group.id));
        break;
    }
  }
  const toObjectIdCache = (records: ReadonlyMap<string, ObjectMappingRecord>): Map<string, string> => {
    const cache = new Map<string, string>();
    for (const [chromiumLocalId, record] of records) cache.set(chromiumLocalId, record.objectId);
    return cache;
  };
  const emptyMappings = Promise.resolve(new Map<string, ObjectMappingRecord>());
  const [tabMaps, windowMaps, groupMaps] = await Promise.all([
    tabIds.size > 0 ? getMappingsByLocalIds(TAB_TYPE, [...tabIds]) : emptyMappings,
    windowIds.size > 0 ? getMappingsByLocalIds(WINDOW_TYPE, [...windowIds]) : emptyMappings,
    groupIds.size > 0 ? getMappingsByLocalIds(GROUP_TYPE, [...groupIds]) : emptyMappings,
  ]);
  return {
    tab: toObjectIdCache(tabMaps),
    window: toObjectIdCache(windowMaps),
    group: toObjectIdCache(groupMaps),
  };
}

// Same kill-switch shape as history/bookmarks (see history/index.ts's
// comment): two flags because "Tabs" and "Tab groups" are independent
// settings. Synchronous listener checks + async flush backstop, fail-open.
let tabsCaptureEnabled = true;
let tabGroupsCaptureEnabled = true;

export function setTabsCaptureEnabled(enabled: boolean): void {
  tabsCaptureEnabled = enabled;
}

export function setTabGroupsCaptureEnabled(enabled: boolean): void {
  tabGroupsCaptureEnabled = enabled;
}

async function readCaptureToggles(): Promise<{ tabsOn: boolean; groupsOn: boolean }> {
  try {
    const settings = await fetchSettings();
    return { tabsOn: settings.syncTabs !== false, groupsOn: settings.syncTabGroups !== false };
  } catch {
    return { tabsOn: true, groupsOn: true };
  }
}

async function restorePolicy(): Promise<"disabled" | "ask" | "automatic"> {
  try {
    // Long-TTL policy cache (api/client.ts): tab batches used to pay a
    // settings fetch per TTL window; the policy only changes via explicit
    // user action and this fails closed to "disabled" on any error.
    return await fetchTabRestorePolicy();
  } catch {
    return "disabled"; // fail closed: never auto-materialize tabs if settings are unreachable
  }
}

// --- Windows --------------------------------------------------------------
// Window open/close used to bypass the micro-batch below, paying
// createLocalOperation + recordLocalFieldState's full per-event overhead each
// time (a session restore opening many windows paid it N times serially).
// They are staged like any other tab event now: one batched encrypt + one
// batched field-state write per burst. Windows carry only liveness (no
// dedup-sensitive payload), so staging never touches the overlay.

async function stageWindowCreated(
  win: chrome.windows.Window,
  caches?: TabFlushCaches,
): Promise<StagedTabOp | null> {
  if (win.id === undefined || win.id === chrome.windows.WINDOW_ID_NONE) return null;
  const objectId = caches
    ? await cachedGetOrCreateObjectId(WINDOW_TYPE, String(win.id), caches.window)
    : await getOrCreateObjectId(WINDOW_TYPE, String(win.id));
  const payload: WindowPayload = {
    focused: win.focused,
    incognito: win.incognito,
    state: win.state,
  };
  return {
    objectType: WINDOW_TYPE,
    objectId,
    operationType: "create",
    payload,
    fields: [{ field: "liveness", value: "live" }],
  };
}

async function stageWindowRemoved(windowId: number, caches?: TabFlushCaches): Promise<StagedTabOp | null> {
  const id = String(windowId);
  const objectId = caches
    ? await cachedLookupObjectId(WINDOW_TYPE, id, caches.window)
    : await lookupObjectId(WINDOW_TYPE, id);
  if (!objectId) return null;
  if (caches) {
    await cachedForgetMapping(WINDOW_TYPE, id, caches.window);
  } else {
    await forgetMapping(WINDOW_TYPE, id); // immediate — see stageRemoved's note in bookmarks/index.ts
  }
  return {
    objectType: WINDOW_TYPE,
    objectId,
    operationType: "close",
    payload: {},
    fields: [{ field: "liveness", value: "deleted" }],
  };
}

// --- Tabs -------------------------------------------------------------------

async function tabPayload(tab: chrome.tabs.Tab, caches?: TabFlushCaches): Promise<TabPayload | undefined> {
  if (tab.id === undefined || tab.windowId === undefined || !tab.url) return undefined;
  const windowId = String(tab.windowId);
  const windowObjectId = caches
    ? await cachedGetOrCreateObjectId(WINDOW_TYPE, windowId, caches.window)
    : await getOrCreateObjectId(WINDOW_TYPE, windowId);
  let groupObjectId: string | null = null;
  if (tabGroupsSupported && tab.groupId !== undefined && tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
    const groupId = String(tab.groupId);
    groupObjectId = caches
      ? await cachedGetOrCreateObjectId(GROUP_TYPE, groupId, caches.group)
      : await getOrCreateObjectId(GROUP_TYPE, groupId);
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

// EXT-4: as in bookmarks/index.ts, a burst of chrome.tabs/chrome.tabGroups
// events (bulk tab import, window restore) used to pay createLocalOperation
// + recordLocalFieldState's full overhead once per event. Listeners below
// do only the synchronous guard/dedup-relevant checks that must run at
// event-fire time and push everything else onto a shared micro-batch queue;
// `flushTabEvents` turns the whole queue into one createLocalOperationsBatch
// + one recordLocalFieldStatesBatch call. See bookmarks/index.ts's matching
// section for the fuller rationale (same shared helper, same shape).

export type QueuedTabEvent =
  | { kind: "tabCreated"; tab: chrome.tabs.Tab }
  | { kind: "tabUpdated"; tabId: number; tab: chrome.tabs.Tab; titleOnly?: boolean }
  | { kind: "tabActivated"; activeInfo: chrome.tabs.TabActiveInfo }
  | { kind: "tabRemoved"; tabId: number }
  | { kind: "groupUpdated"; group: chrome.tabGroups.TabGroup }
  | { kind: "groupRemoved"; group: chrome.tabGroups.TabGroup }
  | { kind: "windowCreated"; win: chrome.windows.Window }
  | { kind: "windowRemoved"; windowId: number };

export interface StagedTabOp {
  objectType: ObjectType;
  objectId: string;
  operationType: OperationType;
  payload: unknown;
  fields: Array<{ field: string; value: unknown }>;
  // Set when this update came from the pure-title debounce path
  // (handleTabUpdated). Used only for the scheduleLocalSync decision below —
  // the op itself is still durably queued like any other update.
  titleOnly?: boolean;
  // Window this activation belongs to (activate ops only, from
  // chrome.tabs.TabActiveInfo.windowId). Lets coalesceStagedOps keep just the
  // last activation per window: only one tab per window can be active at a
  // time, so an earlier activation for the same window is superseded by a
  // later one no matter which tab it names.
  windowId?: number;
}

// EXT-05: Trailing debounce for progressive document title changes during page
// navigation. Web applications cycle through multiple title changes (loading,
// site name, article title, notification badges) in quick succession; buffering
// pure title updates prevents emitting redundant encrypted update operations.
export const TAB_TITLE_DEBOUNCE_MS = 500;
// Background-tab titles (badge counters, progress tickers, media-player
// metadata) must NOT arm a debounce timer: each tick re-arms it, so a 600ms
// ticker holds a 3s timer — and with it the whole service worker — awake
// indefinitely (measured: ~88% of wall time pinned while producing zero
// useful ops). Nothing materializes title-only state promptly on peers (see
// flushTabEvents' hasMeaningfulOp gate), so background titles only stash
// their latest snapshot and drain piggybacked on the next flushTabEvents run
// or the suspend flush — no timer, no pin.
// Latest tab snapshot per debounced-or-stashed tabId, so `flushPendingTitleDebounces`
// (onSuspend path) can enqueue the trailing update instead of dropping it
// when the service worker is torn down mid-debounce. Kept in lockstep with
// `pendingTitleDebounce` below for timer-owned entries; background-stashed
// entries live here with NO entry in that map. Tests assert on both maps'
// keys. Stores only the fields `tabPayload` reads — a full Tab retains extra
// strings (favIconUrl, status, etc.) per pending debounce for no benefit.
export const pendingTitleTabs = new Map<number, chrome.tabs.Tab>();
// Live trailing timers for active-tab pure-title updates, keyed by tabId.
// Background tabs never appear here (see above) — only in pendingTitleTabs.
export const pendingTitleDebounce = new Map<number, ReturnType<typeof setTimeout>>();
// Consecutive pure-title arms per tabId without an intervening non-title
// event or removal. A chronically ticking active tab (video progress, badge
// counter) re-arms its 500ms timer on every tick and pins the worker
// indefinitely for zero useful ops; past MAX_TITLE_REARMS it is downgraded
// to the timerless stash path (same as background tabs) until real activity
// resets the count.
const titleRearmCount = new Map<number, number>();
const MAX_TITLE_REARMS = 10;
// Stash entries are one slim tab each (~hundreds of bytes) and normally
// bounded by the open-tab count, but a long session churning through many
// distinct background tabIds must not grow this without bound — oldest
// (Map insertion order) is dropped first. Drained entries are authoritative
// history only for the next flush, so dropping a stale stash just loses one
// intermediate title, never a durable op.
const MAX_STASHED_TITLES = 200;

function stashTitleTab(tabId: number, tab: chrome.tabs.Tab): void {
  if (!pendingTitleTabs.has(tabId) && pendingTitleTabs.size >= MAX_STASHED_TITLES) {
    const oldest = pendingTitleTabs.keys().next();
    if (!oldest.done) {
      pendingTitleTabs.delete(oldest.value);
      pendingTitleDebounce.delete(oldest.value);
    }
  }
  pendingTitleTabs.set(tabId, slimTabForDebounce(tab));
}
function slimTabForDebounce(tab: chrome.tabs.Tab): chrome.tabs.Tab {
  return {
    id: tab.id,
    windowId: tab.windowId,
    url: tab.url,
    title: tab.title,
    pinned: tab.pinned,
    index: tab.index,
    active: tab.active,
    groupId: tab.groupId,
  } as chrome.tabs.Tab;
}

export function clearTitleDebounce(tabId: number): void {
  titleRearmCount.delete(tabId);
  const timer = pendingTitleDebounce.get(tabId);
  if (timer !== undefined) {
    clearTimeout(timer);
    pendingTitleDebounce.delete(tabId);
    pendingTitleTabs.delete(tabId);
  }
}

export function clearAllTitleDebounce(): void {
  for (const timer of pendingTitleDebounce.values()) {
    clearTimeout(timer);
  }
  pendingTitleDebounce.clear();
  pendingTitleTabs.clear();
  titleRearmCount.clear();
}

/** Enqueue every trailing title update still waiting out its debounce, plus
 * every background-stashed title (see TAB_TITLE_DEBOUNCE_MS's comment).
 * Called from the onSuspend last-chance flush path so a teardown mid-window
 * doesn't silently drop the final title. Idempotent: clears timers first,
 * so a timer racing this call can't double-enqueue. Every timer-owned tabId
 * is also present in `pendingTitleTabs` by construction, so one loop over
 * that map covers both. */
export function flushPendingTitleDebounces(
  enqueue: (event: QueuedTabEvent) => void = enqueueTabEvent,
): void {
  const entries = [...pendingTitleTabs.entries()];
  for (const [tabId, tab] of entries) {
    const timer = pendingTitleDebounce.get(tabId);
    if (timer !== undefined) clearTimeout(timer);
    pendingTitleDebounce.delete(tabId);
    pendingTitleTabs.delete(tabId);
    enqueue({ kind: "tabUpdated", tabId, tab, titleOnly: true });
  }
}

/** Moves background-stashed titles (no live timer — see
 * TAB_TITLE_DEBOUNCE_MS's comment) into queue events for the current flush,
 * oldest-first ahead of `events` so the overlay chains chronologically and
 * `coalesceStagedOps` keeps the newer in-batch update, never a stale stash.
 * Entries with a live timer are owned by that timer and left alone. */
function drainStashedBackgroundTitles(): QueuedTabEvent[] {
  if (pendingTitleTabs.size === 0) return [];
  const drained: QueuedTabEvent[] = [];
  for (const [tabId, tab] of pendingTitleTabs) {
    if (pendingTitleDebounce.has(tabId)) continue;
    pendingTitleTabs.delete(tabId);
    drained.push({ kind: "tabUpdated", tabId, tab, titleOnly: true });
  }
  return drained;
}

/** Per-flush overlay of field values staged earlier in the same batch but
 * not yet committed to IndexedDB — see bookmarks/index.ts's matching
 * overlay for the full rationale. Here it covers "state" (tab/group
 * payload dedup) and "active", so e.g. a tab update immediately following
 * that same tab's creation earlier in the same burst is compared against
 * the just-created payload, not stale pre-batch state. */
function overlayKey(objectId: string, field: string): string {
  return `${objectId}:${field}`;
}
async function overlayOrFieldState(
  overlay: Map<string, unknown>,
  objectId: string,
  field: string,
): Promise<unknown> {
  const key = overlayKey(objectId, field);
  if (overlay.has(key)) return overlay.get(key);
  const value = (await getFieldState(objectId, field))?.value;
  overlay.set(key, value);
  return value;
}

async function stageTabCreated(
  tab: chrome.tabs.Tab,
  overlay: Map<string, unknown>,
  caches?: TabFlushCaches,
): Promise<StagedTabOp | null> {
  if (tab.id === undefined) return null;
  const payload = await tabPayload(tab, caches);
  if (!payload) return null;
  const tabId = String(tab.id);
  const objectId = caches
    ? await cachedGetOrCreateObjectId(TAB_TYPE, tabId, caches.tab)
    : await getOrCreateObjectId(TAB_TYPE, tabId);
  overlay.set(overlayKey(objectId, "state"), payload);
  return {
    objectType: TAB_TYPE,
    objectId,
    operationType: "create",
    payload,
    fields: [
      { field: "state", value: payload },
      { field: "liveness", value: "live" },
    ],
  };
}

/** Field-wise equality for tab payloads. Replaces a double
 * `JSON.stringify` per `onUpdated` event (O(payload) serialize x2 on every
 * keystroke/scroll-driven burst, and fragile to key order) with a direct
 * comparison of the fields `tabPayload` actually tracks. */
export function tabPayloadsEqual(a: TabPayload, b: TabPayload): boolean {
  return (
    a.url === b.url &&
    a.title === b.title &&
    a.pinned === b.pinned &&
    a.index === b.index &&
    a.windowObjectId === b.windowObjectId &&
    a.active === b.active &&
    a.groupObjectId === b.groupObjectId
  );
}

function tabGroupPayloadsEqual(a: TabGroupPayload, b: TabGroupPayload): boolean {
  return a.title === b.title && a.color === b.color && a.collapsed === b.collapsed;
}

/** A real tab navigation/reload fires onUpdated across several async
 * stages (status: "loading" -> title/favIconUrl -> status: "complete"),
 * only the first of which (if any) falls inside `materializeTab`'s
 * synchronous `guard.run` window — the later ones arrive after the guard
 * has already reset. The value-equality check below (via the overlay) is
 * what actually stops those from re-triggering: by the time materializeTab
 * ran, `applyTabRemote` had already resolved and stored this exact payload
 * in field_state, so any onUpdated echoing the same state (whenever it
 * arrives) is a no-op here rather than a new "update" operation — which is
 * what would otherwise ping-pong indefinitely between two devices both
 * running the "automatic" restore policy. */
async function stageTabUpdated(
  tabId: number,
  tab: chrome.tabs.Tab,
  overlay: Map<string, unknown>,
  caches?: TabFlushCaches,
  titleOnly?: boolean,
): Promise<StagedTabOp | null> {
  const id = String(tabId);
  const objectId = caches
    ? await cachedLookupObjectId(TAB_TYPE, id, caches.tab)
    : await lookupObjectId(TAB_TYPE, id);
  if (!objectId) return null;
  const payload = await tabPayload(tab, caches);
  if (!payload) return null;
  const current = (await overlayOrFieldState(overlay, objectId, "state")) as TabPayload | undefined;
  if (current !== undefined && tabPayloadsEqual(current, payload)) return null;
  overlay.set(overlayKey(objectId, "state"), payload);
  return { objectType: TAB_TYPE, objectId, operationType: "update", payload, fields: [{ field: "state", value: payload }], ...(titleOnly ? { titleOnly: true as const } : {}) };
}

async function stageTabActivated(
  activeInfo: chrome.tabs.TabActiveInfo,
  overlay: Map<string, unknown>,
  caches?: TabFlushCaches,
): Promise<StagedTabOp | null> {
  const id = String(activeInfo.tabId);
  const objectId = caches
    ? await cachedLookupObjectId(TAB_TYPE, id, caches.tab)
    : await lookupObjectId(TAB_TYPE, id);
  if (!objectId) return null;
  // Chrome can re-fire onActivated for a tab that's already the active one
  // (e.g. a window focus change) — skip the redundant operation rather
  // than uploading an identical "activate" every time.
  const current = await overlayOrFieldState(overlay, objectId, "active");
  if (current === true) return null;
  overlay.set(overlayKey(objectId, "active"), true);
  return {
    objectType: TAB_TYPE,
    objectId,
    operationType: "activate",
    payload: { active: true },
    fields: [{ field: "active", value: true }],
    windowId: activeInfo.windowId,
  };
}

async function stageTabRemoved(tabId: number, caches?: TabFlushCaches): Promise<StagedTabOp | null> {
  clearTitleDebounce(tabId);
  const id = String(tabId);
  const objectId = caches
    ? await cachedLookupObjectId(TAB_TYPE, id, caches.tab)
    : await lookupObjectId(TAB_TYPE, id);
  if (!objectId) return null;
  if (caches) {
    await cachedForgetMapping(TAB_TYPE, id, caches.tab);
  } else {
    await forgetMapping(TAB_TYPE, id); // immediate — see stageRemoved's note in bookmarks/index.ts
  }
  return {
    objectType: TAB_TYPE,
    objectId,
    operationType: "close",
    payload: {},
    fields: [{ field: "liveness", value: "deleted" }],
  };
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

  await groupSyncLock.run(groupObjectId, async () => {
    const existingGroupId = await lookupChromiumLocalId(groupObjectId);
    const groupId = await guard.run(() =>
      chrome.tabs.group(tabsGroupOptions(Number(chromiumTabId), existingGroupId)),
    );
    await establishMapping(GROUP_TYPE, String(groupId), groupObjectId);

    const stored = await getFieldState(groupObjectId, "state");
    if (stored?.value) {
      await guard.run(() => chrome.tabGroups.update(groupId, tabGroupUpdateProps(stored.value as TabGroupPayload)));
    }
  });
}

async function stageGroupUpdated(
  group: chrome.tabGroups.TabGroup,
  overlay: Map<string, unknown>,
  caches?: TabFlushCaches,
): Promise<StagedTabOp | null> {
  const id = String(group.id);
  const objectId = caches
    ? await cachedGetOrCreateObjectId(GROUP_TYPE, id, caches.group)
    : await getOrCreateObjectId(GROUP_TYPE, id);
  const payload: TabGroupPayload = {
    title: group.title,
    color: group.color,
    collapsed: group.collapsed,
  };
  const current = (await overlayOrFieldState(overlay, objectId, "state")) as TabGroupPayload | undefined;
  if (current !== undefined && tabGroupPayloadsEqual(current, payload)) return null;
  overlay.set(overlayKey(objectId, "state"), payload);
  overlay.set(overlayKey(objectId, "liveness"), "live");
  return {
    objectType: GROUP_TYPE,
    objectId,
    operationType: "update",
    payload,
    fields: [
      { field: "state", value: payload },
      { field: "liveness", value: "live" },
    ],
  };
}

async function stageGroupRemoved(
  group: chrome.tabGroups.TabGroup,
  caches?: TabFlushCaches,
): Promise<StagedTabOp | null> {
  const id = String(group.id);
  const objectId = caches
    ? await cachedLookupObjectId(GROUP_TYPE, id, caches.group)
    : await lookupObjectId(GROUP_TYPE, id);
  if (!objectId) return null;
  if (caches) {
    await cachedForgetMapping(GROUP_TYPE, id, caches.group);
  } else {
    await forgetMapping(GROUP_TYPE, id); // immediate — see stageRemoved's note in bookmarks/index.ts
  }
  return {
    objectType: GROUP_TYPE,
    objectId,
    operationType: "delete",
    payload: {},
    fields: [{ field: "liveness", value: "deleted" }],
  };
}

/** EXT-05 & EXT-03: Coalesce multiple staged operations for the same `objectId` within a batch:
 * - If multiple `update` operations for the same `objectId` are staged within the batch,
 *   keep only the latest `update` operation.
 * - If multiple `activate` operations for the same `objectId` are staged within the batch,
 *   keep only the latest `activate` operation.
 * - If a `close` operation is staged for an `objectId`, discard any earlier `update`
 *   or `activate` operations for that `objectId` in the same batch.
 */
export function coalesceStagedOps(staged: StagedTabOp[]): StagedTabOp[] {
  // Pre-pass: only one tab per window is active at a time, so an earlier
  // activate for a window is superseded by a later activate for the SAME
  // window, whichever tab each names (a switch storm A->B->C keeps just C's
  // activation, not one op per visited tab). Activates without a windowId
  // (and all non-activate ops) skip this and keep the legacy per-objectId
  // behavior in the pass below. This never drops a close: closes are
  // non-activate ops and always survive this filter; the pass below still
  // lets a close discard its own object's earlier ops.
  const lastActivateIdxByWindow = new Map<number, number>();
  staged.forEach((op, i) => {
    if (op.operationType === "activate" && op.windowId !== undefined) {
      lastActivateIdxByWindow.set(op.windowId, i);
    }
  });
  const windowFiltered =
    lastActivateIdxByWindow.size === 0
      ? staged
      : staged.filter(
          (op, i) =>
            op.operationType !== "activate" ||
            op.windowId === undefined ||
            lastActivateIdxByWindow.get(op.windowId) === i,
        );

  const result: StagedTabOp[] = [];
  const discardEarlierUpdate = new Set<string>();
  const discardEarlierActivate = new Set<string>();

  for (let i = windowFiltered.length - 1; i >= 0; i--) {
    const op = windowFiltered[i];
    if (op.operationType === "close") {
      discardEarlierUpdate.add(op.objectId);
      discardEarlierActivate.add(op.objectId);
      result.push(op);
    } else if (op.operationType === "update") {
      if (!discardEarlierUpdate.has(op.objectId)) {
        discardEarlierUpdate.add(op.objectId);
        result.push(op);
      }
    } else if (op.operationType === "activate") {
      if (!discardEarlierActivate.has(op.objectId)) {
        discardEarlierActivate.add(op.objectId);
        result.push(op);
      }
    } else {
      result.push(op);
    }
  }

  return result.reverse();
}

export async function flushTabEvents(events: QueuedTabEvent[]): Promise<void> {
  // Backstop for the synchronous listener flags (covers a burst already
  // queued when the user toggles Tabs/Tab groups off). When Tabs is off the
  // whole batch is dropped and any pending title state is discarded with
  // it; when only Tab groups is off, tab/window events still flow and just
  // the group events are filtered out. Fail-open on settings errors.
  {
    const { tabsOn, groupsOn } = await readCaptureToggles();
    if (!tabsOn) {
      clearAllTitleDebounce();
      return;
    }
    if (!groupsOn) {
      events = events.filter((e) => e.kind !== "groupUpdated" && e.kind !== "groupRemoved");
      if (events.length === 0) return;
    }
  }
  // Piggyback-drain for background-stashed titles (no timers of their own):
  // prepended so overlay/coalesce ordering stays chronological (stash is
  // older than anything in `events`). Zero-cost when nothing is stashed —
  // the singleton fast paths below keep their exact shape.
  const stashed = drainStashedBackgroundTitles();
  if (stashed.length > 0) events = [...stashed, ...events];
  // Fast path: a lone tab-switch costs 2 IDB round trips instead of the full
  // prefetch (3 mapping transactions + 2 overlay-seeding transactions). This
  // is the most frequent flush shape during normal browsing.
  if (events.length === 1 && events[0].kind === "tabActivated") {
    const id = String(events[0].activeInfo.tabId);
    const objectId = await lookupObjectId(TAB_TYPE, id);
    if (!objectId) return;
    const current = (await getFieldState(objectId, "active"))?.value;
    if (current === true) return;
    const created = await createLocalOperationsBatch([
      { objectType: TAB_TYPE, objectId, operationType: "activate", payload: { active: true } },
    ]);
    const [{ operation, deviceId }] = created;
    await recordLocalFieldState(
      objectId,
      "active",
      opKey(operation.lamportTimestamp, deviceId, operation.operationId, "activate"),
      true,
    );
    return;
  }
  const overlay = new Map<string, unknown>();
  // Singleton fast path (generalizing the tabActivated one above): one event
  // needs at most two mapping lookups and one field read. The prefetch below
  // spends up to 3 mapping transactions + 2 overlay-seeding transactions to
  // serve it — measured at 4 transactions for a lone tabCreated whose create
  // path never reads field state at all. With empty caches/overlay the
  // staging loop falls back to its existing per-event live reads, which for a
  // single event cost the same or less.
  const caches: TabFlushCaches = events.length === 1
    ? { tab: new Map(), window: new Map(), group: new Map() }
    : await prefetchTabFlushCaches(events);
  // Seed the overlay the same way bookmarks does: staging's dedup reads
  // (tab/group "state", tab "active") would otherwise cost one sequential
  // `getFieldState` per distinct object. Two batched reads collapse those
  // to 2 transactions; misses are seeded as `undefined` so the first touch
  // doesn't re-pay for a DB miss.
  if (events.length !== 1) {
    const tabIds = [...new Set(caches.tab.values())];
    const groupIds = [...new Set(caches.group.values())];
    const stateIds = [...new Set([...tabIds, ...groupIds])];
    const [stateLookup, activeLookup] = await Promise.all([
      stateIds.length > 0 ? getFieldStatesForObjects(stateIds, "state") : Promise.resolve(new Map()),
      tabIds.length > 0 ? getFieldStatesForObjects(tabIds, "active") : Promise.resolve(new Map()),
    ]);
    for (const id of stateIds) overlay.set(overlayKey(id, "state"), stateLookup.get(id)?.value);
    for (const id of tabIds) overlay.set(overlayKey(id, "active"), activeLookup.get(id)?.value);
  }
  const staged: StagedTabOp[] = [];

  for (const event of events) {
    try {
      let op: StagedTabOp | null;
      switch (event.kind) {
        case "tabCreated":
          op = await stageTabCreated(event.tab, overlay, caches);
          break;
        case "tabUpdated":
          op = await stageTabUpdated(event.tabId, event.tab, overlay, caches, event.titleOnly);
          break;
        case "tabActivated":
          op = await stageTabActivated(event.activeInfo, overlay, caches);
          break;
        case "tabRemoved":
          op = await stageTabRemoved(event.tabId, caches);
          break;
        case "groupUpdated":
          op = await stageGroupUpdated(event.group, overlay, caches);
          break;
        case "groupRemoved":
          op = await stageGroupRemoved(event.group, caches);
          break;
        case "windowCreated":
          op = await stageWindowCreated(event.win, caches);
          break;
        case "windowRemoved":
          op = await stageWindowRemoved(event.windowId, caches);
          break;
      }
      if (op) staged.push(op);
    } catch (e) {
      // Per-event error isolation, matching the old per-listener .catch:
      // one bad event in a burst must not drop or corrupt the rest of the
      // batch's operations.
      console.error(`HelixSync tabs capture (${event.kind})`, e);
    }
  }
  if (staged.length === 0) return;

  // EXT-05: Coalesce staged ops within the batch: keep only the latest
  // "update" operation for a given objectId, and discard any earlier "update"
  // operations if a "close" operation is staged for the same objectId.
  const coalesced = coalesceStagedOps(staged);
  if (coalesced.length === 0) return;

  const pending: PendingLocalOperation[] = coalesced.map((op) => ({
    objectType: op.objectType,
    objectId: op.objectId,
    operationType: op.operationType,
    payload: op.payload,
  }));
  // Reserves one contiguous device-sequence/lamport range for the whole
  // batch — `staged` is in original event-fire order, so the range is
  // assigned in that same chronological order too.
  const created = await createLocalOperationsBatch(pending);

  const fieldStateEntries: LocalFieldStateEntry[] = [];
  created.forEach(({ operation, deviceId }, idx) => {
    const op = coalesced[idx];
    const key = opKey(operation.lamportTimestamp, deviceId, operation.operationId, op.operationType);
    for (const f of op.fields) {
      fieldStateEntries.push({ objectId: op.objectId, field: f.field, key, value: f.value });
    }
  });
  await recordLocalFieldStatesBatch(fieldStateEntries);
  // EXT-1: operations are now durably in pending_operations — nudge a sync
  // cycle instead of leaving them for the next alarm/push (see
  // scheduleLocalSync's doc comment in sync/engine.ts). Exception: a batch
  // made up entirely of "activate" ops (i.e. only tab-switch events, which
  // fire on every chrome.tabs.onActivated during normal browsing) or of
  // title-only "update" ops (badge-count/title-progress tickers that fire
  // while the user is idle — measured at one sync nudge per storm before
  // this exception) skips the immediate debounced push — nothing on the
  // receiving end materializes this state promptly enough for the extra
  // wake to matter, so pushing it right away just wakes every peer
  // device's service worker for no observable effect. The operations are
  // still written to pending_operations above, so they go out on the next
  // regular alarm/push like any other op; a batch with any other op still
  // triggers the immediate sync as before.
  const hasMeaningfulOp = coalesced.some(
    (op) => op.operationType !== "activate" && !(op.operationType === "update" && op.titleOnly),
  );
  if (hasMeaningfulOp) scheduleLocalSync();
}

export const enqueueTabEvent = createMicroBatchQueue<QueuedTabEvent>(flushTabEvents);

export function handleTabUpdated(
  tabId: number,
  changeInfo: chrome.tabs.TabChangeInfo,
  tab: chrome.tabs.Tab,
  enqueue: (event: QueuedTabEvent) => void = enqueueTabEvent,
): void {
  if (
    changeInfo.url === undefined &&
    changeInfo.title === undefined &&
    changeInfo.pinned === undefined &&
    changeInfo.groupId === undefined
  ) {
    return;
  }
  if (!tabsCaptureEnabled) return; // "Tabs" toggled off in settings
  if (guard.isSuppressed()) return;

  const isPureTitle =
    changeInfo.title !== undefined &&
    changeInfo.url === undefined &&
    changeInfo.pinned === undefined &&
    changeInfo.groupId === undefined;

  // Preserve the consecutive-ticker count across the re-arm below:
  // clearTitleDebounce resets it (right for removals), but here the previous
  // trailing timer is just being replaced by its successor.
  const priorRearms = titleRearmCount.get(tabId) ?? 0;
  const liveTimer = pendingTitleDebounce.get(tabId);
  if (liveTimer !== undefined) {
    clearTimeout(liveTimer);
    pendingTitleDebounce.delete(tabId);
    pendingTitleTabs.delete(tabId);
  }
  if (isPureTitle) {
    const rearms = priorRearms + 1;
    titleRearmCount.set(tabId, rearms);
    const slim = slimTabForDebounce(tab);
    if (tab.active && rearms <= MAX_TITLE_REARMS) {
      const timer = setTimeout(() => {
        pendingTitleDebounce.delete(tabId);
        pendingTitleTabs.delete(tabId);
        // A completed debounce means the ticker paused >= the window — not
        // a hot ticker — so the count restarts rather than accumulating
        // across slow, legitimate title sequences.
        titleRearmCount.delete(tabId);
        enqueue({ kind: "tabUpdated", tabId, tab: slim, titleOnly: true });
      }, TAB_TITLE_DEBOUNCE_MS);
      pendingTitleDebounce.set(tabId, timer);
      pendingTitleTabs.set(tabId, slim);
    } else if (rearms <= MAX_TITLE_REARMS) {
      // Background tabs (never arm a timer — see TAB_TITLE_DEBOUNCE_MS's
      // comment): stash only. Drains via drainStashedBackgroundTitles /
      // flushPendingTitleDebounces. A tab past MAX_TITLE_REARMS consecutive
      // pure-title ticks (chronic ticker: badge counter, progress updates)
      // is dropped instead of stashed — its titles are superseded noise,
      // and stashing would only mint a titleOnly op on the next unrelated
      // flush for zero peer-visible effect (see flushTabEvents'
      // hasMeaningfulOp gate, which never nudges sync for those).
      stashTitleTab(tabId, tab);
    }
    // else: chronic ticker — drop (don't even stash).
  } else {
    titleRearmCount.delete(tabId);
    enqueue({ kind: "tabUpdated", tabId, tab });
  }
}

export function handleTabRemoved(
  tabId: number,
  enqueue: (event: QueuedTabEvent) => void = enqueueTabEvent,
): void {
  clearTitleDebounce(tabId);
  if (tabId === lastActiveTabId) lastActiveTabId = undefined;
  if (!tabsCaptureEnabled) return; // "Tabs" toggled off in settings
  enqueue({ kind: "tabRemoved", tabId });
}

let captureRegistered = false;

// Chrome can re-fire onActivated for the already-active tab (e.g. window
// focus changes). Memory-only dedup so repeats never even reach the
// micro-batch queue; the field-state check in flushTabEvents remains the
// durable backstop across restarts.
let lastActiveTabId: number | undefined;

export function resetCaptureStateForTesting(): void {
  captureRegistered = false;
  lastActiveTabId = undefined;
  tabsCaptureEnabled = true;
  tabGroupsCaptureEnabled = true;
  clearAllTitleDebounce();
}

export function registerCapture(): void {
  // See the matching guard in bookmarks/index.ts::registerCapture — called
  // on every startup and every REFRESH_CAPTURE_CONFIG message (settings
  // save), so this must stay idempotent or repeated saves register every
  // listener below multiple times.
  if (captureRegistered) return;
  captureRegistered = true;

  chrome.windows.onCreated.addListener((win) => {
    if (!tabsCaptureEnabled) return; // "Tabs" toggled off in settings
    if (win.id === undefined || win.id === chrome.windows.WINDOW_ID_NONE) return;
    enqueueTabEvent({ kind: "windowCreated", win });
  });
  chrome.windows.onRemoved.addListener((id) => {
    if (!tabsCaptureEnabled) return;
    enqueueTabEvent({ kind: "windowRemoved", windowId: id });
  });

  // EXT-4: guard/dedup checks that must run synchronously at event-fire
  // time stay inline here (see the local-capture section's top comment and
  // the matching note in bookmarks/index.ts::registerCapture) — everything
  // else is pushed onto the shared micro-batch queue and handled by
  // flushTabEvents.
  chrome.tabs.onCreated.addListener((tab) => {
    if (!tabsCaptureEnabled) return; // "Tabs" toggled off in settings
    if (guard.isSuppressed()) return; // our own materializeTab() chrome.tabs.create() call
    enqueueTabEvent({ kind: "tabCreated", tab });
  });
  // Only react to the properties `tabPayload` actually reads (url, title,
  // pinned, groupId — `active`/`index` are tracked via onActivated / not
  // tracked at all, respectively). Filtered natively via onUpdated's
  // `properties` filter (measured: 4 of 5 events per page load are
  // status/favIcon/audible noise that otherwise wakes the service worker
  // just to be discarded) with the same check below as a backstop for
  // runtimes that ignore the filter. This project's @types/chrome doesn't
  // model the filter argument for this event, so it goes through a narrow
  // cast at this single call site rather than weakening the shared types.
  //
  // EXT-05: Web apps progressively update document.title during navigation.
  // We apply a per-tab trailing debounce (TAB_TITLE_DEBOUNCE_MS) for pure title
  // updates to prevent intermediate titles from triggering redundant operations.
  type OnUpdatedWithFilter = {
    addListener(
      cb: (tabId: number, changeInfo: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => void,
      filter?: { properties?: Array<keyof chrome.tabs.TabChangeInfo> },
    ): void;
  };
  (chrome.tabs.onUpdated as unknown as OnUpdatedWithFilter).addListener(
    (tabId, changeInfo, tab) => {
      handleTabUpdated(tabId, changeInfo, tab);
    },
    { properties: ["url", "title", "pinned", "groupId"] },
  );
  chrome.tabs.onActivated.addListener((info) => {
    if (!tabsCaptureEnabled) return; // before the dedup update, so re-enabling sees fresh state
    if (info.tabId === lastActiveTabId) return;
    lastActiveTabId = info.tabId;
    enqueueTabEvent({ kind: "tabActivated", activeInfo: info });
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    handleTabRemoved(tabId);
  });

  if (tabGroupsSupported) {
    chrome.tabGroups.onUpdated.addListener((group) => {
      if (!tabGroupsCaptureEnabled) return; // "Tab groups" toggled off in settings
      if (guard.isSuppressed()) return; // our own syncTabGroup()/applyGroupRemote() chrome.tabGroups.update() call
      enqueueTabEvent({ kind: "groupUpdated", group });
    });
    chrome.tabGroups.onRemoved.addListener((group) => {
      if (!tabGroupsCaptureEnabled) return;
      enqueueTabEvent({ kind: "groupRemoved", group });
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
      deleted: liveValue === "deleted" ? 1 : 0,
      updatedAt: op.createdAt,
    });
  }
}

async function applyTabRemote(
  op: OperationOut,
  payload: unknown,
  cachedPolicy?: "disabled" | "ask" | "automatic",
): Promise<void> {
  const key = opKey(op.lamportTimestamp, op.deviceId, op.operationId, op.operationType);

  if (op.operationType === "close") {
    const r = await resolveField(op.objectId, "liveness", { ...key, value: "deleted" });
    if (r.applied) {
      await putRemoteObject({
        objectId: op.objectId,
        objectType: TAB_TYPE,
        originDeviceId: op.deviceId,
        payload: null,
        deleted: 1,
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
    deleted: liveness.value === "deleted" ? 1 : 0,
    updatedAt: op.createdAt,
  });

  if (liveness.value !== "live") return;

  const policy = cachedPolicy ?? (await restorePolicy());
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
    // Mapping storage uses strings for all Chromium IDs, while the tabs API
    // requires a numeric tab ID at runtime (a TypeScript cast does not
    // convert it).
    const tabId = Number(existingChromiumId);
    if (!Number.isSafeInteger(tabId) || tabId < 0) {
      throw new Error(`Invalid mapped Chromium tab ID: ${existingChromiumId}`);
    }
    await guard.run(() =>
      chrome.tabs.update(tabId, { url: p.url, pinned: p.pinned }),
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

// Bounded concurrency for restore-all materialization: each tab still pays
// its own chrome.tabs.create IPC plus tab-group join, but a 100+-tab
// snapshot no longer serializes all of that one tab at a time. Matches
// REMOTE_APPLY_CONCURRENCY above (same per-item cost shape).
const REMOTE_RESTORE_CONCURRENCY = 10;

/** Bulk counterpart to `restoreTab` for the "ask" policy's "Restore all"
 * action (background/index.ts): one batch field-state read for every tab
 * instead of one `getFieldState` transaction per tab, then the same
 * `materializeTab` path per winner with bounded concurrency. Skips tabs
 * with no resolved state, same as `restoreTab` returning early. */
export async function restoreTabs(objectIds: string[]): Promise<void> {
  if (objectIds.length === 0) return;
  const states = await getFieldStatesForObjects(objectIds, "state");
  const targets: Array<{ objectId: string; payload: TabPayload }> = [];
  for (const objectId of objectIds) {
    const value = states.get(objectId)?.value as TabPayload | undefined;
    if (value) targets.push({ objectId, payload: value });
  }
  for (const batch of chunk(targets, REMOTE_RESTORE_CONCURRENCY)) {
    await Promise.all(batch.map(({ objectId, payload }) => materializeTab(objectId, payload)));
    await yieldToEventLoop();
  }
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
        deleted: 1,
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
    deleted: 0,
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

// Bounded concurrency for remote apply: each item still pays its own
// field-state transaction plus browser IPC, but a 200-tab snapshot no
// longer serializes all of that one op at a time on the single MV3 thread.
// Matches sync/engine.ts's TOMBSTONE_APPLY_CONCURRENCY.
const REMOTE_APPLY_CONCURRENCY = 10;

async function applyWindowRemoteBatch(items: Array<{ op: OperationOut; payload: unknown }>): Promise<void> {
  if (items.length === 0) return;
  // One field-state transaction for the whole batch instead of one per op:
  // every window op resolves exactly its "liveness" slot, so entries in
  // wire order observe each other exactly as sequential resolveField calls
  // would. The remote_objects writes collapse into one transaction too.
  const results = await resolveFieldsBatch(
    items.map(({ op }): BatchFieldResolution => {
      const key = opKey(op.lamportTimestamp, op.deviceId, op.operationId, op.operationType);
      return {
        objectId: op.objectId,
        field: "liveness",
        incoming: { ...key, value: op.operationType === "close" ? "deleted" : "live" },
      };
    }),
  );
  const records: RemoteObjectRecord[] = [];
  items.forEach(({ op, payload }, i) => {
    if (!results[i].applied) return;
    const liveValue = op.operationType === "close" ? "deleted" : "live";
    records.push({
      objectId: op.objectId,
      objectType: WINDOW_TYPE,
      originDeviceId: op.deviceId,
      payload,
      deleted: liveValue === "deleted" ? 1 : 0,
      updatedAt: op.createdAt,
    });
  });
  await putRemoteObjectsBatch(records);
}

async function applyTabRemoteBatch(items: Array<{ op: OperationOut; payload: unknown }>): Promise<void> {
  if (items.length === 0) return;
  // One policy read per batch instead of one per op — fetchTabRestorePolicy
  // is TTL-cached, but each call still pays a storage.session IPC round trip.
  const policy = await restorePolicy();
  // Phase 1: resolve every touched slot in one transaction, in wire order.
  // Each item contributes 1–2 entries; entryIndexes[i] records which result
  // positions belong to item i so phase 2 can replay applyTabRemote's exact
  // per-item logic (single-op path stays for snapshot tombstones, which
  // bypass batch appliers via applyOneRemote).
  const entries: BatchFieldResolution[] = [];
  const entryIndexes: number[][] = [];
  for (const { op, payload } of items) {
    const key = opKey(op.lamportTimestamp, op.deviceId, op.operationId, op.operationType);
    const idx: number[] = [];
    if (op.operationType === "close") {
      idx.push(entries.length);
      entries.push({ objectId: op.objectId, field: "liveness", incoming: { ...key, value: "deleted" } });
    } else if (op.operationType === "activate") {
      idx.push(entries.length);
      entries.push({ objectId: op.objectId, field: "active", incoming: { ...key, value: true } });
    } else {
      // create / update — same pair (and order) as applyTabRemote's
      // resolveFields call.
      idx.push(entries.length);
      entries.push({ objectId: op.objectId, field: "state", incoming: { ...key, value: payload } });
      idx.push(entries.length);
      entries.push({ objectId: op.objectId, field: "liveness", incoming: { ...key, value: "live" } });
    }
    entryIndexes.push(idx);
  }
  const results = await resolveFieldsBatch(entries);

  // Phase 2: winners share one bulk remote_objects write and one bulk
  // mapping cleanup; materialization keeps its bounded concurrency since
  // each item still pays browser IPC.
  const records: RemoteObjectRecord[] = [];
  const closedObjectIds: string[] = [];
  const toMaterialize: Array<{ objectId: string; payload: TabPayload }> = [];
  items.forEach(({ op }, i) => {
    if (op.operationType === "close") {
      if (results[entryIndexes[i][0]].applied) {
        records.push({
          objectId: op.objectId,
          objectType: TAB_TYPE,
          originDeviceId: op.deviceId,
          payload: null,
          deleted: 1,
          updatedAt: op.createdAt,
        });
        closedObjectIds.push(op.objectId);
      }
      return;
    }
    if (op.operationType === "activate") return; // active-only: field state above is the whole effect
    const stateResult = results[entryIndexes[i][0]];
    const liveness = results[entryIndexes[i][1]];
    if (!stateResult.applied) return;
    records.push({
      objectId: op.objectId,
      objectType: TAB_TYPE,
      originDeviceId: op.deviceId,
      payload: stateResult.value,
      deleted: liveness.value === "deleted" ? 1 : 0,
      updatedAt: op.createdAt,
    });
    if (liveness.value !== "live") return;
    if (policy !== "automatic") return;
    toMaterialize.push({ objectId: op.objectId, payload: stateResult.value as TabPayload });
  });
  await putRemoteObjectsBatch(records);
  if (closedObjectIds.length > 0) {
    const mappings = await getMappingsByObjectIds(closedObjectIds);
    await deleteMappingsBatch(
      TAB_TYPE,
      [...mappings.values()].map((m) => m.chromiumLocalId),
    );
  }
  for (const batch of chunk(toMaterialize, REMOTE_APPLY_CONCURRENCY)) {
    await Promise.all(batch.map(({ objectId, payload }) => materializeTab(objectId, payload)));
    await yieldToEventLoop();
  }
}

async function applyGroupRemoteBatch(items: Array<{ op: OperationOut; payload: unknown }>): Promise<void> {
  if (items.length === 0) return;
  // Same two-phase shape as applyTabRemoteBatch: one resolution
  // transaction for the batch, one bulk remote_objects write, then the
  // chrome.tabGroups metadata updates (no bulk API exists) with bounded
  // concurrency.
  const entries: BatchFieldResolution[] = [];
  const entryIndexes: number[][] = [];
  for (const { op, payload } of items) {
    const key = opKey(op.lamportTimestamp, op.deviceId, op.operationId, op.operationType);
    const idx: number[] = [];
    if (op.operationType === "delete") {
      idx.push(entries.length);
      entries.push({ objectId: op.objectId, field: "liveness", incoming: { ...key, value: "deleted" } });
    } else {
      idx.push(entries.length);
      entries.push({ objectId: op.objectId, field: "state", incoming: { ...key, value: payload } });
      idx.push(entries.length);
      entries.push({ objectId: op.objectId, field: "liveness", incoming: { ...key, value: "live" } });
    }
    entryIndexes.push(idx);
  }
  const results = await resolveFieldsBatch(entries);

  const records: RemoteObjectRecord[] = [];
  const metadataUpdates: Array<{ objectId: string; payload: TabGroupPayload }> = [];
  items.forEach(({ op }, i) => {
    if (op.operationType === "delete") {
      if (results[entryIndexes[i][0]].applied) {
        records.push({
          objectId: op.objectId,
          objectType: GROUP_TYPE,
          originDeviceId: op.deviceId,
          payload: null,
          deleted: 1,
          updatedAt: op.createdAt,
        });
      }
      return;
    }
    const stateResult = results[entryIndexes[i][0]];
    if (!stateResult.applied) return;
    records.push({
      objectId: op.objectId,
      objectType: GROUP_TYPE,
      originDeviceId: op.deviceId,
      payload: stateResult.value,
      deleted: 0,
      updatedAt: op.createdAt,
    });
    metadataUpdates.push({ objectId: op.objectId, payload: stateResult.value as TabGroupPayload });
  });
  await putRemoteObjectsBatch(records);

  // Group membership itself is materialized from the tab side (syncTabGroup)
  // — same rule as applyGroupRemote's single-op path: only groups that
  // already exist locally get their metadata applied here.
  if (tabGroupsSupported && metadataUpdates.length > 0) {
    const mappings = await getMappingsByObjectIds(metadataUpdates.map((u) => u.objectId));
    const runnable = metadataUpdates.flatMap((u) => {
      const chromiumId = mappings.get(u.objectId)?.chromiumLocalId;
      return chromiumId !== undefined ? [{ chromiumId, payload: u.payload }] : [];
    });
    for (const batch of chunk(runnable, REMOTE_APPLY_CONCURRENCY)) {
      await Promise.all(
        batch.map(({ chromiumId, payload }) =>
          guard.run(() => chrome.tabGroups.update(Number(chromiumId), tabGroupUpdateProps(payload))),
        ),
      );
      await yieldToEventLoop();
    }
  }
}

registerApplier(WINDOW_TYPE, applyWindowRemote);
registerApplier(TAB_TYPE, applyTabRemote);
registerApplier(GROUP_TYPE, applyGroupRemote);
registerBatchApplier(WINDOW_TYPE, applyWindowRemoteBatch);
registerBatchApplier(TAB_TYPE, applyTabRemoteBatch);
registerBatchApplier(GROUP_TYPE, applyGroupRemoteBatch);
