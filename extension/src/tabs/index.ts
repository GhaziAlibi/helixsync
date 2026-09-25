// Tabs, windows and tab groups (docs/protocol.md §8.4/§8.5). These are
// device-scoped session state: a remote tab is materialized as a real local
// tab only under the "automatic" restore policy (or an explicit "Restore"
// under "ask"), and is otherwise tracked for display only. That's what
// guarantees a remote tab can never destroy an unrelated local one.
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
  type ResolveResult,
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
import { isSyncableUrl } from "../util/url-scheme";
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
import type { TabActiveInfo, TabChangeInfo } from "../util/chrome-types";

const WINDOW_TYPE: ObjectType = "window";
const TAB_TYPE: ObjectType = "tab";
const GROUP_TYPE: ObjectType = "tabGroup";

const tabGroupsSupported = typeof chrome.tabGroups !== "undefined";

// Remote-apply chrome.tabs/tabGroups mutations run inside guard.run so their
// synchronous events aren't recaptured. A tab's later async loading events
// escape the guard; the value-equality checks in stageTabUpdated and
// stageGroupUpdated catch those. Without both, two devices on "automatic"
// would bounce the same change back and forth forever.
const guard = createSuppressionGuard();

// Restore-all materializes tabs concurrently. Two tabs from the same remote
// group would otherwise each create their own local group.
const groupSyncLock = createKeyedLock();

type RestorePolicy = "disabled" | "ask" | "automatic";

function opKey(lamportTimestamp: number, deviceId: string, operationId: string, operationType: OperationType) {
  return { lamportTimestamp, deviceId, operationId, operationType };
}

function hasTabGroup(tab: chrome.tabs.Tab): boolean {
  return tabGroupsSupported && tab.groupId !== undefined && tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE;
}

/** Per-flush memo of Chromium id -> objectId per type, so a burst sharing
 * the same window/group/tab doesn't repeat the same lookup. */
interface TabFlushCaches {
  tab: Map<string, string>;
  window: Map<string, string>;
  group: Map<string, string>;
}

function emptyTabFlushCaches(): TabFlushCaches {
  return { tab: new Map(), window: new Map(), group: new Map() };
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

/** Drops the mapping immediately, in lockstep with the flush cache. */
async function cachedForgetMapping(
  objectType: ObjectType,
  chromiumLocalId: string,
  cache: Map<string, string>,
): Promise<void> {
  cache.delete(chromiumLocalId);
  await forgetMapping(objectType, chromiumLocalId);
}

/** One mapping lookup per object type for every id the burst references.
 * Ids created mid-burst are filled in by the cached* helpers. */
async function prefetchTabFlushCaches(events: QueuedTabEvent[]): Promise<TabFlushCaches> {
  const tabIds = new Set<string>();
  const windowIds = new Set<string>();
  const groupIds = new Set<string>();
  const collectTabRef = (tab: chrome.tabs.Tab) => {
    if (tab.id !== undefined) tabIds.add(String(tab.id));
    if (tab.windowId !== undefined) windowIds.add(String(tab.windowId));
    if (hasTabGroup(tab)) groupIds.add(String(tab.groupId));
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

// Synchronous listener kill-switches for the independent "Tabs" and "Tab
// groups" settings; the flush-time settings check is the backstop. Both
// fail open.
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

async function restorePolicy(): Promise<RestorePolicy> {
  try {
    return await fetchTabRestorePolicy();
  } catch {
    return "disabled"; // fail closed: never auto-materialize if settings are unreachable
  }
}

// --- Local capture: browser event -> operation --------------------------
// Listeners do only the checks that must run at event-fire time and queue
// the rest; `flushTabEvents` turns each burst into one batched encrypt and
// one batched field-state write.

export type QueuedTabEvent =
  | { kind: "tabCreated"; tab: chrome.tabs.Tab }
  | { kind: "tabUpdated"; tabId: number; tab: chrome.tabs.Tab; titleOnly?: boolean }
  | { kind: "tabActivated"; activeInfo: TabActiveInfo }
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
  // Set for updates from the title debounce; only affects whether the flush
  // nudges a sync.
  titleOnly?: boolean;
  // Activations only: one tab per window can be active, so coalescing keeps
  // just the last activation per window.
  windowId?: number;
}

/** Looks up and forgets the mapping of a removed tab, window or group, and
 * stages its terminal operation. */
async function stageRemoval(
  objectType: ObjectType,
  chromiumLocalId: string,
  cache: Map<string, string>,
  operationType: OperationType,
): Promise<StagedTabOp | null> {
  const objectId = await cachedLookupObjectId(objectType, chromiumLocalId, cache);
  if (!objectId) return null;
  await cachedForgetMapping(objectType, chromiumLocalId, cache);
  return {
    objectType,
    objectId,
    operationType,
    payload: {},
    fields: [{ field: "liveness", value: "deleted" }],
  };
}

// --- Windows ---------------------------------------------------------------

async function stageWindowCreated(win: chrome.windows.Window, caches: TabFlushCaches): Promise<StagedTabOp | null> {
  if (win.id === undefined || win.id === chrome.windows.WINDOW_ID_NONE) return null;
  const objectId = await cachedGetOrCreateObjectId(WINDOW_TYPE, String(win.id), caches.window);
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

function stageWindowRemoved(windowId: number, caches: TabFlushCaches): Promise<StagedTabOp | null> {
  return stageRemoval(WINDOW_TYPE, String(windowId), caches.window, "close");
}

// --- Tabs ------------------------------------------------------------------

async function tabPayload(tab: chrome.tabs.Tab, caches: TabFlushCaches): Promise<TabPayload | undefined> {
  if (tab.id === undefined || tab.windowId === undefined || !tab.url) return undefined;
  const windowObjectId = await cachedGetOrCreateObjectId(WINDOW_TYPE, String(tab.windowId), caches.window);
  const groupObjectId = hasTabGroup(tab)
    ? await cachedGetOrCreateObjectId(GROUP_TYPE, String(tab.groupId), caches.group)
    : null;
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

// Pure title changes (a page cycling through loading/site/article titles)
// are debounced per tab so intermediate titles don't each become an op.
export const TAB_TITLE_DEBOUNCE_MS = 500;
// Background-tab title tickers (badge counters, progress, media metadata)
// never arm a timer: re-arming on every tick would keep the service worker
// awake indefinitely for no useful ops. Their latest snapshot is stashed
// and rides along with the next flush or the suspend flush.
//
// Latest slim tab snapshot per pending tabId. Timer-owned entries also have
// a `pendingTitleDebounce` timer; stashed background entries don't.
export const pendingTitleTabs = new Map<number, chrome.tabs.Tab>();
export const pendingTitleDebounce = new Map<number, ReturnType<typeof setTimeout>>();
// Consecutive pure-title events per tab. Past MAX_TITLE_REARMS an active
// tab is treated as a chronic ticker and its titles are dropped until some
// other activity resets the count.
const titleRearmCount = new Map<number, number>();
const MAX_TITLE_REARMS = 10;
// Bounds the stash across a long session; the oldest entry is dropped
// first, which loses at most one intermediate title.
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

/** Keeps only the fields `tabPayload` reads. */
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

/** Enqueues every pending title (debounced or stashed) from the onSuspend
 * path, so a teardown doesn't drop the final title. Clears timers first so
 * a racing timer can't enqueue twice. */
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

/** Turns stashed background titles into events for the current flush.
 * Entries owned by a live timer are left to it. */
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

// Per-flush overlay of "state" and "active" values staged earlier in the
// same burst, so e.g. an update right after a create compares against the
// just-created payload rather than stale stored state.
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
  caches: TabFlushCaches,
): Promise<StagedTabOp | null> {
  if (tab.id === undefined) return null;
  const payload = await tabPayload(tab, caches);
  if (!payload) return null;
  const objectId = await cachedGetOrCreateObjectId(TAB_TYPE, String(tab.id), caches.tab);
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

/** A navigation fires onUpdated in several async stages, most of them after
 * materializeTab's guard window has closed. Those stages echo a payload the
 * remote apply already recorded, so the equality check drops them. */
async function stageTabUpdated(
  tabId: number,
  tab: chrome.tabs.Tab,
  overlay: Map<string, unknown>,
  caches: TabFlushCaches,
  titleOnly?: boolean,
): Promise<StagedTabOp | null> {
  const objectId = await cachedLookupObjectId(TAB_TYPE, String(tabId), caches.tab);
  if (!objectId) return null;
  const payload = await tabPayload(tab, caches);
  if (!payload) return null;
  const current = (await overlayOrFieldState(overlay, objectId, "state")) as TabPayload | undefined;
  if (current !== undefined && tabPayloadsEqual(current, payload)) return null;
  overlay.set(overlayKey(objectId, "state"), payload);
  return {
    objectType: TAB_TYPE,
    objectId,
    operationType: "update",
    payload,
    fields: [{ field: "state", value: payload }],
    ...(titleOnly ? { titleOnly: true as const } : {}),
  };
}

async function stageTabActivated(
  activeInfo: TabActiveInfo,
  overlay: Map<string, unknown>,
  caches: TabFlushCaches,
): Promise<StagedTabOp | null> {
  const objectId = await cachedLookupObjectId(TAB_TYPE, String(activeInfo.tabId), caches.tab);
  if (!objectId) return null;
  // Chrome re-fires onActivated for the already-active tab on focus changes.
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

function stageTabRemoved(tabId: number, caches: TabFlushCaches): Promise<StagedTabOp | null> {
  clearTitleDebounce(tabId);
  return stageRemoval(TAB_TYPE, String(tabId), caches.tab, "close");
}

// --- Tab groups (feature-detected, docs/protocol.md §14) -------------------

/** Joins (or creates) the local group for a remote `groupObjectId` and
 * applies its synced metadata. Called only once a member tab has actually
 * been materialized (§8.5: membership follows each tab's group). */
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
  caches: TabFlushCaches,
): Promise<StagedTabOp | null> {
  const objectId = await cachedGetOrCreateObjectId(GROUP_TYPE, String(group.id), caches.group);
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

function stageGroupRemoved(group: chrome.tabGroups.TabGroup, caches: TabFlushCaches): Promise<StagedTabOp | null> {
  return stageRemoval(GROUP_TYPE, String(group.id), caches.group, "delete");
}

/** Coalesces staged ops within one batch:
 * - only the last activation per window survives;
 * - only the latest update and the latest activation per object survive;
 * - a close discards that object's earlier updates and activations. */
export function coalesceStagedOps(staged: StagedTabOp[]): StagedTabOp[] {
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

/** Fast path for the most common flush during browsing, a lone tab switch:
 * two IndexedDB reads instead of the full prefetch. */
async function flushLoneActivation(activeInfo: TabActiveInfo): Promise<void> {
  const objectId = await lookupObjectId(TAB_TYPE, String(activeInfo.tabId));
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
}

/** Seeds the overlay with stored "state"/"active" values for every prefetched
 * object in two batched reads; misses are seeded as `undefined`. */
async function seedOverlay(overlay: Map<string, unknown>, caches: TabFlushCaches): Promise<void> {
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

function stageEvent(event: QueuedTabEvent, overlay: Map<string, unknown>, caches: TabFlushCaches): Promise<StagedTabOp | null> {
  switch (event.kind) {
    case "tabCreated":
      return stageTabCreated(event.tab, overlay, caches);
    case "tabUpdated":
      return stageTabUpdated(event.tabId, event.tab, overlay, caches, event.titleOnly);
    case "tabActivated":
      return stageTabActivated(event.activeInfo, overlay, caches);
    case "tabRemoved":
      return stageTabRemoved(event.tabId, caches);
    case "groupUpdated":
      return stageGroupUpdated(event.group, overlay, caches);
    case "groupRemoved":
      return stageGroupRemoved(event.group, caches);
    case "windowCreated":
      return stageWindowCreated(event.win, caches);
    case "windowRemoved":
      return stageWindowRemoved(event.windowId, caches);
  }
}

export async function flushTabEvents(events: QueuedTabEvent[]): Promise<void> {
  // Backstop for the listener flags: with Tabs off the whole batch (and any
  // pending titles) is dropped; with only Tab groups off, group events are.
  const { tabsOn, groupsOn } = await readCaptureToggles();
  if (!tabsOn) {
    clearAllTitleDebounce();
    return;
  }
  if (!groupsOn) {
    events = events.filter((e) => e.kind !== "groupUpdated" && e.kind !== "groupRemoved");
    if (events.length === 0) return;
  }
  // Stashed titles are older than anything in `events`, so they go first.
  const stashed = drainStashedBackgroundTitles();
  if (stashed.length > 0) events = [...stashed, ...events];

  if (events.length === 1 && events[0].kind === "tabActivated") {
    await flushLoneActivation(events[0].activeInfo);
    return;
  }
  const overlay = new Map<string, unknown>();
  // A single event costs fewer round trips with live reads than with the
  // batch prefetch.
  const isSingleton = events.length === 1;
  const caches = isSingleton ? emptyTabFlushCaches() : await prefetchTabFlushCaches(events);
  if (!isSingleton) await seedOverlay(overlay, caches);

  const staged: StagedTabOp[] = [];
  for (const event of events) {
    try {
      const op = await stageEvent(event, overlay, caches);
      if (op) staged.push(op);
    } catch (e) {
      // One bad event must not drop the rest of the burst.
      console.error(`HelixSync tabs capture (${event.kind})`, e);
    }
  }
  if (staged.length === 0) return;

  const coalesced = coalesceStagedOps(staged);
  if (coalesced.length === 0) return;

  const pending: PendingLocalOperation[] = coalesced.map((op) => ({
    objectType: op.objectType,
    objectId: op.objectId,
    operationType: op.operationType,
    payload: op.payload,
  }));
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
  // Activation-only and title-only batches don't nudge a sync: peers don't
  // act on that state promptly, so waking them would cost cycles for
  // nothing. The ops still go out with the next regular sync.
  const hasMeaningfulOp = coalesced.some(
    (op) => op.operationType !== "activate" && !(op.operationType === "update" && op.titleOnly),
  );
  if (hasMeaningfulOp) scheduleLocalSync();
}

export const enqueueTabEvent = createMicroBatchQueue<QueuedTabEvent>(flushTabEvents);

export function handleTabUpdated(
  tabId: number,
  changeInfo: TabChangeInfo,
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
  if (!tabsCaptureEnabled) return;
  if (guard.isSuppressed()) return;

  const isPureTitle =
    changeInfo.title !== undefined &&
    changeInfo.url === undefined &&
    changeInfo.pinned === undefined &&
    changeInfo.groupId === undefined;

  // Read before clearing: replacing the trailing timer must not reset the
  // consecutive-title count.
  const priorRearms = titleRearmCount.get(tabId) ?? 0;
  const liveTimer = pendingTitleDebounce.get(tabId);
  if (liveTimer !== undefined) {
    clearTimeout(liveTimer);
    pendingTitleDebounce.delete(tabId);
    pendingTitleTabs.delete(tabId);
  }
  if (!isPureTitle) {
    titleRearmCount.delete(tabId);
    enqueue({ kind: "tabUpdated", tabId, tab });
    return;
  }

  const rearms = priorRearms + 1;
  titleRearmCount.set(tabId, rearms);
  // Chronic tickers (past MAX_TITLE_REARMS) are dropped entirely.
  if (rearms > MAX_TITLE_REARMS) return;
  if (!tab.active) {
    stashTitleTab(tabId, tab);
    return;
  }
  const slim = slimTabForDebounce(tab);
  const timer = setTimeout(() => {
    pendingTitleDebounce.delete(tabId);
    pendingTitleTabs.delete(tabId);
    // The title settled for a full window, so this isn't a hot ticker.
    titleRearmCount.delete(tabId);
    enqueue({ kind: "tabUpdated", tabId, tab: slim, titleOnly: true });
  }, TAB_TITLE_DEBOUNCE_MS);
  pendingTitleDebounce.set(tabId, timer);
  pendingTitleTabs.set(tabId, slim);
}

export function handleTabRemoved(
  tabId: number,
  enqueue: (event: QueuedTabEvent) => void = enqueueTabEvent,
): void {
  clearTitleDebounce(tabId);
  if (tabId === lastActiveTabId) lastActiveTabId = undefined;
  if (!tabsCaptureEnabled) return;
  enqueue({ kind: "tabRemoved", tabId });
}

let captureRegistered = false;

// In-memory dedup of repeated onActivated for the same tab, so repeats never
// reach the queue. The field-state check is the backstop across restarts.
let lastActiveTabId: number | undefined;

export function resetCaptureStateForTesting(): void {
  captureRegistered = false;
  lastActiveTabId = undefined;
  tabsCaptureEnabled = true;
  tabGroupsCaptureEnabled = true;
  clearAllTitleDebounce();
}

export function registerCapture(): void {
  // Called on every startup and settings save; must stay idempotent.
  if (captureRegistered) return;
  captureRegistered = true;

  chrome.windows.onCreated.addListener((win) => {
    if (!tabsCaptureEnabled) return;
    if (win.id === undefined || win.id === chrome.windows.WINDOW_ID_NONE) return;
    enqueueTabEvent({ kind: "windowCreated", win });
  });
  chrome.windows.onRemoved.addListener((id) => {
    if (!tabsCaptureEnabled) return;
    enqueueTabEvent({ kind: "windowRemoved", windowId: id });
  });

  chrome.tabs.onCreated.addListener((tab) => {
    if (!tabsCaptureEnabled) return;
    if (guard.isSuppressed()) return;
    enqueueTabEvent({ kind: "tabCreated", tab });
  });
  // The native `properties` filter keeps status/favicon/audible updates from
  // waking the worker at all; handleTabUpdated re-checks for runtimes that
  // ignore it. @types/chrome doesn't model the filter argument.
  type OnUpdatedWithFilter = {
    addListener(
      cb: (tabId: number, changeInfo: TabChangeInfo, tab: chrome.tabs.Tab) => void,
      filter?: { properties?: Array<keyof TabChangeInfo> },
    ): void;
  };
  (chrome.tabs.onUpdated as unknown as OnUpdatedWithFilter).addListener(
    (tabId, changeInfo, tab) => {
      handleTabUpdated(tabId, changeInfo, tab);
    },
    { properties: ["url", "title", "pinned", "groupId"] },
  );
  chrome.tabs.onActivated.addListener((info) => {
    // Checked before the dedup update so re-enabling sees fresh state.
    if (!tabsCaptureEnabled) return;
    if (info.tabId === lastActiveTabId) return;
    lastActiveTabId = info.tabId;
    enqueueTabEvent({ kind: "tabActivated", activeInfo: info });
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    handleTabRemoved(tabId);
  });

  if (tabGroupsSupported) {
    chrome.tabGroups.onUpdated.addListener((group) => {
      if (!tabGroupsCaptureEnabled) return;
      if (guard.isSuppressed()) return;
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
// Remote state is always recorded in remote_objects for the "tabs from other
// devices" view. Only the "automatic" policy materializes tabs here; "ask"
// is surfaced by the popup.

function remoteObjectRecord(
  op: OperationOut,
  objectType: ObjectType,
  payload: unknown,
  deleted: boolean,
): RemoteObjectRecord {
  return {
    objectId: op.objectId,
    objectType,
    originDeviceId: op.deviceId,
    payload,
    deleted: deleted ? 1 : 0,
    updatedAt: op.createdAt,
  };
}

async function applyWindowRemote(op: OperationOut, payload: unknown): Promise<void> {
  const key = opKey(op.lamportTimestamp, op.deviceId, op.operationId, op.operationType);
  const liveValue = op.operationType === "close" ? "deleted" : "live";
  const r = await resolveField(op.objectId, "liveness", { ...key, value: liveValue });
  if (r.applied) {
    await putRemoteObject(remoteObjectRecord(op, WINDOW_TYPE, payload, liveValue === "deleted"));
  }
}

async function applyTabRemote(
  op: OperationOut,
  payload: unknown,
  cachedPolicy?: RestorePolicy,
): Promise<void> {
  const key = opKey(op.lamportTimestamp, op.deviceId, op.operationId, op.operationType);

  if (op.operationType === "close") {
    const r = await resolveField(op.objectId, "liveness", { ...key, value: "deleted" });
    if (r.applied) {
      await putRemoteObject(remoteObjectRecord(op, TAB_TYPE, null, true));
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

  await putRemoteObject(remoteObjectRecord(op, TAB_TYPE, stateResult.value, liveness.value === "deleted"));

  if (liveness.value !== "live") return;

  const policy = cachedPolicy ?? (await restorePolicy());
  if (policy !== "automatic") return;

  await materializeTab(op.objectId, stateResult.value as TabPayload);
}

/** Creates the local tab for a remote tab (or updates the one already
 * mapped) and joins its group. The single materialization path for both the
 * "automatic" policy and an explicit "Restore". */
async function materializeTab(objectId: string, p: TabPayload): Promise<void> {
  if (!isSyncableUrl(p.url)) return;

  const existingChromiumId = await lookupChromiumLocalId(objectId);
  let chromiumId: string | undefined = existingChromiumId;
  if (existingChromiumId) {
    // Mappings store ids as strings; the tabs API needs a real number.
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

/** The popup's per-tab "Restore" under the "ask" policy. Uses the state
 * already resolved for the tab, whatever the policy. */
export async function restoreTab(objectId: string): Promise<void> {
  const stored = await getFieldState(objectId, "state");
  if (!stored?.value) return;
  await materializeTab(objectId, stored.value as TabPayload);
}

// Each item pays browser IPC, so remote applies run a few at a time.
const REMOTE_APPLY_CONCURRENCY = 10;

/** "Restore all": one batched state read, then bounded-concurrency
 * materialization. Tabs without resolved state are skipped. */
export async function restoreTabs(objectIds: string[]): Promise<void> {
  if (objectIds.length === 0) return;
  const states = await getFieldStatesForObjects(objectIds, "state");
  const targets: Array<{ objectId: string; payload: TabPayload }> = [];
  for (const objectId of objectIds) {
    const value = states.get(objectId)?.value as TabPayload | undefined;
    if (value) targets.push({ objectId, payload: value });
  }
  await materializeAll(targets);
}

async function materializeAll(targets: Array<{ objectId: string; payload: TabPayload }>): Promise<void> {
  for (const batch of chunk(targets, REMOTE_APPLY_CONCURRENCY)) {
    await Promise.all(batch.map(({ objectId, payload }) => materializeTab(objectId, payload)));
    await yieldToEventLoop();
  }
}

async function applyGroupRemote(op: OperationOut, payload: unknown): Promise<void> {
  const key = opKey(op.lamportTimestamp, op.deviceId, op.operationId, op.operationType);
  if (op.operationType === "delete") {
    const r = await resolveField(op.objectId, "liveness", { ...key, value: "deleted" });
    if (r.applied) {
      await putRemoteObject(remoteObjectRecord(op, GROUP_TYPE, null, true));
    }
    return;
  }

  const [stateResult] = await resolveFields(op.objectId, [
    { field: "state", incoming: { ...key, value: payload } },
    { field: "liveness", incoming: { ...key, value: "live" } },
  ]);
  if (!stateResult.applied) return;

  await putRemoteObject(remoteObjectRecord(op, GROUP_TYPE, stateResult.value, false));

  // Groups are created from the tab side once a member tab is restored. If
  // the local group already exists, apply the new metadata right away.
  if (tabGroupsSupported) {
    const existingGroupId = await lookupChromiumLocalId(op.objectId);
    if (existingGroupId !== undefined) {
      await guard.run(() =>
        chrome.tabGroups.update(Number(existingGroupId), tabGroupUpdateProps(stateResult.value as TabGroupPayload)),
      );
    }
  }
}

type RemoteItem = { op: OperationOut; payload: unknown };

/** Resolves every item's fields in one transaction, in wire order, and
 * returns each item's results in the order `fieldsFor` listed them. */
async function resolveItems(
  items: RemoteItem[],
  fieldsFor: (item: RemoteItem, key: ReturnType<typeof opKey>) => Array<{ field: string; value: unknown }>,
): Promise<ResolveResult[][]> {
  const entries: BatchFieldResolution[] = [];
  const counts: number[] = [];
  for (const item of items) {
    const { op } = item;
    const key = opKey(op.lamportTimestamp, op.deviceId, op.operationId, op.operationType);
    const fields = fieldsFor(item, key);
    for (const { field, value } of fields) {
      entries.push({ objectId: op.objectId, field, incoming: { ...key, value } });
    }
    counts.push(fields.length);
  }
  const results = await resolveFieldsBatch(entries);
  let offset = 0;
  return counts.map((count) => {
    const itemResults = results.slice(offset, offset + count);
    offset += count;
    return itemResults;
  });
}

async function applyWindowRemoteBatch(items: RemoteItem[]): Promise<void> {
  if (items.length === 0) return;
  const results = await resolveItems(items, ({ op }) => [
    { field: "liveness", value: op.operationType === "close" ? "deleted" : "live" },
  ]);
  const records: RemoteObjectRecord[] = [];
  items.forEach(({ op, payload }, i) => {
    if (!results[i][0].applied) return;
    records.push(remoteObjectRecord(op, WINDOW_TYPE, payload, op.operationType === "close"));
  });
  await putRemoteObjectsBatch(records);
}

/** Same per-item logic as applyTabRemote, with one policy read, one
 * resolution transaction, one remote_objects write and one mapping cleanup
 * for the whole batch. */
async function applyTabRemoteBatch(items: RemoteItem[]): Promise<void> {
  if (items.length === 0) return;
  const policy = await restorePolicy();
  const results = await resolveItems(items, ({ op, payload }) => {
    if (op.operationType === "close") return [{ field: "liveness", value: "deleted" }];
    if (op.operationType === "activate") return [{ field: "active", value: true }];
    return [
      { field: "state", value: payload },
      { field: "liveness", value: "live" },
    ];
  });

  const records: RemoteObjectRecord[] = [];
  const closedObjectIds: string[] = [];
  const toMaterialize: Array<{ objectId: string; payload: TabPayload }> = [];
  items.forEach(({ op }, i) => {
    if (op.operationType === "close") {
      if (results[i][0].applied) {
        records.push(remoteObjectRecord(op, TAB_TYPE, null, true));
        closedObjectIds.push(op.objectId);
      }
      return;
    }
    // An activation's field state is its whole effect.
    if (op.operationType === "activate") return;
    const [stateResult, liveness] = results[i];
    if (!stateResult.applied) return;
    records.push(remoteObjectRecord(op, TAB_TYPE, stateResult.value, liveness.value === "deleted"));
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
  await materializeAll(toMaterialize);
}

async function applyGroupRemoteBatch(items: RemoteItem[]): Promise<void> {
  if (items.length === 0) return;
  const results = await resolveItems(items, ({ op, payload }) =>
    op.operationType === "delete"
      ? [{ field: "liveness", value: "deleted" }]
      : [
          { field: "state", value: payload },
          { field: "liveness", value: "live" },
        ],
  );

  const records: RemoteObjectRecord[] = [];
  const metadataUpdates: Array<{ objectId: string; payload: TabGroupPayload }> = [];
  items.forEach(({ op }, i) => {
    if (op.operationType === "delete") {
      if (results[i][0].applied) records.push(remoteObjectRecord(op, GROUP_TYPE, null, true));
      return;
    }
    const [stateResult] = results[i];
    if (!stateResult.applied) return;
    records.push(remoteObjectRecord(op, GROUP_TYPE, stateResult.value, false));
    metadataUpdates.push({ objectId: op.objectId, payload: stateResult.value as TabGroupPayload });
  });
  await putRemoteObjectsBatch(records);

  // As in applyGroupRemote, only groups that already exist locally get
  // their metadata applied. chrome.tabGroups has no bulk update.
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
