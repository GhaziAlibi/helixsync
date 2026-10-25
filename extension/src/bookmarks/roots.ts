// The built-in root folders, resolved per device. Chromium hides an empty
// root from extensions on some form factors (Bookmarks bar and Other
// bookmarks on Android, Mobile bookmarks on desktop), and nothing can be
// put in a hidden one. A folder inside a shown root stands in for each
// hidden one: it maps to that root's fixed objectId and never syncs as a
// folder of its own. Once the root is shown again, the stand-in's contents
// move into it.
import type { createSuppressionGuard } from "../sync/suppress";

export const ROOT_OBJECT_IDS: Record<string, string> = {
  "0": "00000000-0000-7000-8000-000000000000",
  "1": "00000000-0000-7000-8000-000000000001", // Bookmarks Bar
  "2": "00000000-0000-7000-8000-000000000002", // Other Bookmarks
  "3": "00000000-0000-7000-8000-000000000003", // Mobile Bookmarks
};

// In the order stand-ins are placed at the top of their host.
const STAND_IN_ROOTS = [
  { rootId: "1", title: "Bookmarks bar" },
  { rootId: "2", title: "Other bookmarks" },
  { rootId: "3", title: "Mobile bookmarks" },
];

// Stand-ins go in the first shown root: Mobile bookmarks is always shown on
// Android, Other bookmarks on desktop.
const HOST_ROOT_PREFERENCE = ["3", "2", "1"];

// Root chromium id -> stand-in folder id. In chrome.storage.local, not
// IndexedDB, so it outlives a disconnect: the folders stay in the browser
// and must still be recognised as roots after reconnecting.
const STAND_INS_STORAGE_KEY = "bookmarkRootStandIns";

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
  const shownRootIds = new Set((await chrome.bookmarks.getChildren("0")).map((node) => node.id));
  const hostId = HOST_ROOT_PREFERENCE.find((id) => shownRootIds.has(id));
  const stored = await storedStandIns();
  let changed = false;

  const objectIdByChromiumId = new Map<string, string>([["0", ROOT_OBJECT_IDS["0"]]]);
  const standInIds = new Set<string>();
  let placed = 0;
  for (const { rootId, title } of STAND_IN_ROOTS) {
    const objectId = ROOT_OBJECT_IDS[rootId];
    const storedId = stored[rootId];
    if (shownRootIds.has(rootId)) {
      objectIdByChromiumId.set(rootId, objectId);
      if (storedId) {
        if (await bookmarkExists(storedId)) await mergeStandInIntoRoot(guard, storedId, rootId);
        delete stored[rootId];
        changed = true;
      }
      continue;
    }

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
