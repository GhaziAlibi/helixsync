// Builds restore point contents from the live bookmark tree (and, for a
// mass-delete point, the subtrees just removed).
import { ROOT_OBJECT_IDS } from "../bookmarks/roots";
import { readLiveBookmarks, type LiveBookmarkNode } from "../bookmarks";
import { keyBetween } from "../util/fractional-index";
import type { PointNode } from "./format";

/** Nodes exist that have no objectId yet (capture not flushed, backfill not
 * finished), so a full tree can't be written. Never produces a partial tree. */
export class BookmarksNotReadyError extends Error {
  readonly code = "bookmarks_not_ready";
  constructor(readonly unmapped: number) {
    super("Bookmarks are still being prepared for sync. Try again in a moment.");
    this.name = "BookmarksNotReadyError";
  }
}

export type CaptureMode =
  /** Every bookmark; refuses while any is unmapped. */
  | { kind: "full" }
  /** Only mapped bookmarks (the import case, where unmapped ones are the
   * browser's own and not yet part of the account). */
  | { kind: "mapped-only" }
  /** The live tree plus subtrees just removed. */
  | { kind: "plus-removed"; removed: LiveBookmarkNode[] };

const ROOT_ORDER = Object.keys(ROOT_OBJECT_IDS)
  .sort()
  .map((id) => ROOT_OBJECT_IDS[id]);

/** Makes sibling positions strictly increasing in the given order, keeping
 * every position that already is and deriving the rest from their
 * neighbours. */
function normalizePositions(siblings: LiveBookmarkNode[]): string[] {
  const positions: string[] = [];
  let prev: string | null = null;
  for (let i = 0; i < siblings.length; i++) {
    const own = siblings[i].position;
    if (own !== undefined && own !== "" && (prev === null || own > prev)) {
      positions.push(own);
      prev = own;
      continue;
    }
    let hi: string | null = null;
    for (let j = i + 1; j < siblings.length; j++) {
      const later = siblings[j].position;
      if (later !== undefined && later !== "" && (prev === null || later > prev)) {
        hi = later;
        break;
      }
    }
    const key = keyBetween(prev, hi);
    positions.push(key);
    prev = key;
  }
  return positions;
}

/** Orders `nodes` parents-first (a top-down walk from the built-in roots),
 * siblings by position, and drops what a point must not hold: managed
 * (policy-set) nodes with everything under them, and nodes that don't reach a
 * root. Removed nodes (`extra`) are merged in by position. */
export function buildPointNodes(live: LiveBookmarkNode[], extra: LiveBookmarkNode[] = []): PointNode[] {
  const childrenOf = new Map<string, LiveBookmarkNode[]>();
  const add = (node: LiveBookmarkNode) => {
    const list = childrenOf.get(node.parentObjectId);
    if (list) list.push(node);
    else childrenOf.set(node.parentObjectId, [node]);
  };
  for (const node of live) add(node);

  if (extra.length > 0) {
    const liveIds = new Set(live.map((n) => n.objectId));
    for (const node of extra) {
      if (liveIds.has(node.objectId)) continue;
      const list = childrenOf.get(node.parentObjectId) ?? [];
      childrenOf.set(node.parentObjectId, list);
      // Live siblings keep the browser's order; a removed one goes before the
      // first sibling with a larger position, else last.
      const at =
        node.position === undefined ? -1 : list.findIndex((s) => s.position !== undefined && s.position > node.position!);
      if (at === -1) list.push(node);
      else list.splice(at, 0, node);
    }
  }

  const out: PointNode[] = [];
  // Preorder, siblings in order. A stack of iterators keeps it iterative.
  const stack: Array<{ siblings: LiveBookmarkNode[]; positions: string[]; i: number }> = [];
  const push = (parentId: string) => {
    const siblings = (childrenOf.get(parentId) ?? []).filter((n) => !n.unmodifiable);
    if (siblings.length > 0) stack.push({ siblings, positions: normalizePositions(siblings), i: 0 });
  };
  for (const rootId of [...ROOT_ORDER].reverse()) push(rootId);
  // Roots were pushed in reverse so the first root is on top.
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame.i >= frame.siblings.length) {
      stack.pop();
      continue;
    }
    const node = frame.siblings[frame.i];
    const x = frame.positions[frame.i];
    frame.i++;
    const pointNode: PointNode = {
      o: node.objectId,
      k: node.kind,
      t: node.title,
      ...(node.kind === "b" && node.url !== undefined ? { u: node.url } : {}),
      p: node.parentObjectId,
      x,
    };
    out.push(pointNode);
    if (node.kind === "f") push(node.objectId);
  }
  return out;
}

export async function captureNodes(mode: CaptureMode): Promise<PointNode[]> {
  const live = await readLiveBookmarks();
  if (mode.kind === "full" && live.unmapped > 0) throw new BookmarksNotReadyError(live.unmapped);
  return buildPointNodes(live.nodes, mode.kind === "plus-removed" ? mode.removed : []);
}

/** SHA-256 over the nodes, hex. Stays on the device: a server-side hash would
 * reveal whether the tree changed. */
export async function hashNodes(nodes: PointNode[]): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(nodes));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}
