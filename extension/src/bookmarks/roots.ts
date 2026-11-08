// The built-in root folders, resolved per device. Each root has a logical
// key ("0"–"4") and a fixed objectId all devices agree on; the browser's own
// id for it differs (Chromium "0"–"3", Firefox "root________" etc.).
//
// Chromium hides an empty root from extensions on some form factors
// (Bookmarks bar and Other bookmarks on Android, Mobile bookmarks on
// desktop), and nothing can be put in a hidden one. A folder inside a shown
// root stands in for each hidden one: it maps to that root's fixed objectId
// and never syncs as a folder of its own. Once the root is shown again, the
// stand-in's contents move into it.
//
// Firefox's Bookmarks menu has no Chromium counterpart. It is a "lazy" root:
// on Chromium its stand-in is created only once something synced belongs in
// it (ensureStandInRoot), so devices that never see Firefox get no folder.
import type { createSuppressionGuard } from "../sync/suppress";
import { isFirefox } from "../util/browser";

/** Logical root key -> fixed objectId. Logical keys "0"–"3" equal the
 * Chromium ids. */
export const ROOT_OBJECT_IDS: Record<string, string> = {
  "0": "00000000-0000-7000-8000-000000000000",
  "1": "00000000-0000-7000-8000-000000000001", // Bookmarks Bar / Toolbar
  "2": "00000000-0000-7000-8000-000000000002", // Other Bookmarks
  "3": "00000000-0000-7000-8000-000000000003", // Mobile Bookmarks
  "4": "00000000-0000-7000-8000-000000000004", // Bookmarks Menu (Firefox)
};

/** Logical root key -> the browser's id for it. A root missing here never
 * exists natively in that browser. */
const CHROMIUM_ROOT_IDS: Record<string, string> = { "0": "0", "1": "1", "2": "2", "3": "3" };
const FIREFOX_ROOT_IDS: Record<string, string> = {
  "0": "root________",
  "1": "toolbar_____",
  "2": "unfiled_____",
  "3": "mobile______",
  "4": "menu________",
};

function nativeRootIds(): Record<string, string> {
  return isFirefox() ? FIREFOX_ROOT_IDS : CHROMIUM_ROOT_IDS;
}

/** True when `id` is one of this browser's built-in root folders. */
export function isNativeRootId(id: string): boolean {
  return Object.values(nativeRootIds()).includes(id);
}

// In the order stand-ins are placed at the top of their host.
const STAND_IN_ROOTS: Array<{ rootId: string; title: string; lazy?: boolean; hosts?: string[] }> = [
  { rootId: "1", title: "Bookmarks bar" },
  { rootId: "2", title: "Other bookmarks" },
  { rootId: "3", title: "Mobile bookmarks" },
  // Next to the other folders on desktop, rather than in Mobile bookmarks.
  { rootId: "4", title: "Bookmarks menu", lazy: true, hosts: ["2", "3", "1"] },
];

const LAZY_ROOT_OBJECT_IDS: ReadonlySet<string> = new Set(
  STAND_IN_ROOTS.filter((r) => r.lazy).map((r) => ROOT_OBJECT_IDS[r.rootId]),
);

/** True for a root whose stand-in is only made on demand. */
export function isLazyRootObjectId(objectId: string): boolean {
  return LAZY_ROOT_OBJECT_IDS.has(objectId);
}

// Stand-ins go in the first shown root: Mobile bookmarks is always shown on
// Android, Other bookmarks on desktop.
const HOST_ROOT_PREFERENCE = ["3", "2", "1"];

// Logical root key -> stand-in folder id. In chrome.storage.local, not
// IndexedDB, so it outlives a disconnect: the folders stay in the browser
// and must still be recognised as roots after reconnecting.
const STAND_INS_STORAGE_KEY = "bookmarkRootStandIns";
// Logical keys of lazy roots asked for at least once.
const LAZY_WANTED_STORAGE_KEY = "bookmarkLazyRootsWanted";

export interface BookmarkRoots {
  objectIdByChromiumId: ReadonlyMap<string, string>;
  chromiumIdByObjectId: ReadonlyMap<string, string>;
  standInIds: ReadonlySet<string>;
}

type SuppressionGuard = ReturnType<typeof createSuppressionGuard>;

let rootsPromise: Promise<BookmarkRoots> | null = null;
let lastResolve: Promise<unknown> = Promise.resolve();

async function storedStandIns(): Promise<Record<string, string>> {
  return ((await chrome.storage.local.get(STAND_INS_STORAGE_KEY))[STAND_INS_STORAGE_KEY] ?? {}) as Record<
    string,
    string
  >;
}

async function wantedLazyRoots(): Promise<string[]> {
  return ((await chrome.storage.local.get(LAZY_WANTED_STORAGE_KEY))[LAZY_WANTED_STORAGE_KEY] ?? []) as string[];
}

/** The root's objectId when `chromiumId` is a stand-in folder. Read from
 * storage rather than the resolved roots, which a worker woken by the
 * folder's removal hasn't resolved yet. */
export async function standInRootObjectId(chromiumId: string): Promise<string | undefined> {
  const stored = await storedStandIns();
  const rootId = Object.keys(stored).find((id) => stored[id] === chromiumId);
  return rootId ? ROOT_OBJECT_IDS[rootId] : undefined;
}

/** Resolved once per worker. `guard` suppresses capture of the stand-in
 * folders this creates. */
export function bookmarkRoots(guard: SuppressionGuard): Promise<BookmarkRoots> {
  if (!rootsPromise) {
    // After any resolve still running from before an invalidation, so two
    // never create the same stand-in.
    const resolving = lastResolve.then(() => resolveRoots(guard));
    lastResolve = resolving.catch(() => {});
    rootsPromise = resolving.catch((e) => {
      rootsPromise = null;
      throw e;
    });
  }
  return rootsPromise;
}

/** Forces the next bookmarkRoots call to re-resolve, recreating a stand-in
 * that was removed. */
export function invalidateBookmarkRoots(): void {
  rootsPromise = null;
}

/** Makes sure the lazy root `objectId` has a folder on this device, creating
 * its stand-in if needed. */
export async function ensureStandInRoot(guard: SuppressionGuard, objectId: string): Promise<BookmarkRoots> {
  const current = await bookmarkRoots(guard);
  if (current.chromiumIdByObjectId.has(objectId)) return current;
  const rootId = Object.keys(ROOT_OBJECT_IDS).find((id) => ROOT_OBJECT_IDS[id] === objectId);
  if (!rootId) return current;
  const wanted = await wantedLazyRoots();
  if (!wanted.includes(rootId)) {
    await chrome.storage.local.set({ [LAZY_WANTED_STORAGE_KEY]: [...wanted, rootId] });
  }
  invalidateBookmarkRoots();
  return bookmarkRoots(guard);
}

async function bookmarkExists(id: string): Promise<boolean> {
  try {
    return (await chrome.bookmarks.get(id)).length > 0;
  } catch {
    return false;
  }
}

/** Moves a stand-in's contents into its root, which is shown again, and
 * removes the stand-in. Mappings and positions don't change: the contents
 * already belonged to that root. */
async function mergeStandInIntoRoot(guard: SuppressionGuard, standInId: string, rootId: string): Promise<void> {
  for (const child of await chrome.bookmarks.getChildren(standInId)) {
    await guard.run(() => chrome.bookmarks.move(child.id, { parentId: rootId }));
  }
  await guard.run(() => chrome.bookmarks.remove(standInId));
}

async function resolveRoots(guard: SuppressionGuard): Promise<BookmarkRoots> {
  const native = nativeRootIds();
  const shownRootIds = new Set((await chrome.bookmarks.getChildren(native["0"])).map((node) => node.id));
  const hostFor = (preference: string[]) =>
    preference.map((id) => native[id]).find((id) => id !== undefined && shownRootIds.has(id));
  const stored = await storedStandIns();
  const wanted = new Set(await wantedLazyRoots());
  let changed = false;

  const objectIdByChromiumId = new Map<string, string>([[native["0"], ROOT_OBJECT_IDS["0"]]]);
  const standInIds = new Set<string>();
  let placed = 0;
  for (const { rootId, title, lazy, hosts } of STAND_IN_ROOTS) {
    const objectId = ROOT_OBJECT_IDS[rootId];
    const nativeId = native[rootId];
    const storedId = stored[rootId];
    if (nativeId !== undefined && shownRootIds.has(nativeId)) {
      objectIdByChromiumId.set(nativeId, objectId);
      if (storedId) {
        if (await bookmarkExists(storedId)) await mergeStandInIntoRoot(guard, storedId, nativeId);
        delete stored[rootId];
        changed = true;
      }
      continue;
    }
    if (lazy && !storedId && !wanted.has(rootId)) continue;

    const hostId = hostFor(hosts ?? HOST_ROOT_PREFERENCE);
    if (!hostId) throw new Error("HelixSync: no bookmark root is shown to hold stand-in folders");
    let standInId = storedId;
    if (!standInId || !(await bookmarkExists(standInId))) {
      const childCount = (await chrome.bookmarks.getChildren(hostId)).length;
      const folder = await guard.run(() =>
        chrome.bookmarks.create({ parentId: hostId, title, index: Math.min(placed, childCount) }),
      );
      standInId = folder.id;
      stored[rootId] = standInId;
      changed = true;
    }
    placed++;
    objectIdByChromiumId.set(standInId, objectId);
    standInIds.add(standInId);
  }
  if (changed) await chrome.storage.local.set({ [STAND_INS_STORAGE_KEY]: stored });

  return {
    objectIdByChromiumId,
    chromiumIdByObjectId: new Map([...objectIdByChromiumId].map(([chromiumId, objectId]) => [objectId, chromiumId])),
    standInIds,
  };
}
