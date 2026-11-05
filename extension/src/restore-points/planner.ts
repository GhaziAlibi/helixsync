// Works out what a restore has to do: the difference between a restore point
// and the browser's bookmarks right now, as the operations that close it.
// Pure, so the rules can be tested without a browser.
import type { LiveBookmarkNode } from "../bookmarks";
import { ROOT_OBJECT_IDS } from "../bookmarks/roots";
import { isSyncableUrl } from "../util/url-scheme";
import type { PointNode, PointPlaintext } from "./format";

export type RestoreMode = "merge" | "exact";

/** "all", or the objectId of a folder in the point. */
export type RestoreScope = "all" | string;

export interface PlannedOperation {
  objectType: "bookmark" | "bookmarkFolder";
  objectId: string;
  operationType: "restore" | "update" | "move" | "delete";
  payload: Record<string, unknown>;
  /** For previews and messages only. */
  title: string;
}

export interface PlanCounts {
  restored: number;
  updated: number;
  moved: number;
  deleted: number;
  /** Nodes left alone because their URL uses a scheme the extension won't
   * create. */
  skipped: number;
}

export interface RestorePlan {
  /** Restores (parents first), then updates, moves, deletes. */
  operations: PlannedOperation[];
  counts: PlanCounts;
  /** A few titles per kind, for the preview. */
  sample: { restored: string[]; updated: string[]; moved: string[]; deleted: string[] };
}

export class UnknownRestoreScopeError extends Error {
  constructor() {
    super("The folder to restore is not in this restore point.");
    this.name = "UnknownRestoreScopeError";
  }
}

const SAMPLE_SIZE = 8;
const ROOT_IDS: ReadonlySet<string> = new Set(Object.values(ROOT_OBJECT_IDS));

function objectTypeOf(kind: "b" | "f"): "bookmark" | "bookmarkFolder" {
  return kind === "b" ? "bookmark" : "bookmarkFolder";
}

/** Plans a restore of `point` over `live` (what the browser holds now: every
 * mapped node; built-in roots are never touched).
 *
 * "Live" means present in the browser right now, not merely known to the
 * account. Per node of the point in scope:
 *  - not live: `restore`, with the point's title, URL, parent and position
 *  - live, different title or URL: `update` (changed fields only)
 *  - live, different parent or position: `move`
 * Exact mode also deletes live nodes in scope that the point doesn't hold,
 * topmost only: a deleted folder takes its contents with it. Moves precede
 * deletes, so a node the point keeps is moved out of a folder that is about to
 * go. A partial scope covers one folder's subtree; if that folder's ancestors
 * are missing they are restored too (and only restored, never edited). */
export function planRestore(
  point: Pick<PointPlaintext, "nodes">,
  live: readonly LiveBookmarkNode[],
  mode: RestoreMode,
  scope: RestoreScope,
): RestorePlan {
  const pointById = new Map<string, PointNode>();
  const pointChildren = new Map<string, PointNode[]>();
  for (const node of point.nodes) {
    pointById.set(node.o, node);
    const siblings = pointChildren.get(node.p);
    if (siblings) siblings.push(node);
    else pointChildren.set(node.p, [node]);
  }
  const liveById = new Map<string, LiveBookmarkNode>();
  for (const node of live) liveById.set(node.objectId, node);

  // Which point nodes the restore covers, and which only need to exist.
  let inScope: ReadonlySet<string>;
  const ancestorsToRestore = new Set<string>();
  if (scope === "all") {
    inScope = new Set(pointById.keys());
  } else {
    const folder = pointById.get(scope);
    if (!folder || folder.k !== "f") throw new UnknownRestoreScopeError();
    const covered = new Set<string>([folder.o]);
    const stack = [folder.o];
    while (stack.length > 0) {
      for (const child of pointChildren.get(stack.pop()!) ?? []) {
        covered.add(child.o);
        if (child.k === "f") stack.push(child.o);
      }
    }
    inScope = covered;
    for (let parent = pointById.get(folder.p); parent; parent = pointById.get(parent.p)) {
      ancestorsToRestore.add(parent.o);
    }
  }

  const restores: PlannedOperation[] = [];
  const updates: PlannedOperation[] = [];
  const moves: PlannedOperation[] = [];
  const counts: PlanCounts = { restored: 0, updated: 0, moved: 0, deleted: 0, skipped: 0 };

  // `point.nodes` lists parents first, so restores come out in that order.
  for (const node of point.nodes) {
    const covered = inScope.has(node.o);
    if (!covered && !ancestorsToRestore.has(node.o)) continue;
    const existing = liveById.get(node.o);

    if (!existing) {
      if (node.k === "b" && !isSyncableUrl(node.u ?? "")) {
        counts.skipped++;
        continue;
      }
      restores.push({
        objectType: objectTypeOf(node.k),
        objectId: node.o,
        operationType: "restore",
        payload: { title: node.t, url: node.k === "b" ? node.u! : null, parent: node.p, position: node.x },
        title: node.t,
      });
      continue;
    }

    // Ancestors outside the scope only have to exist; a managed node can't be
    // edited or moved at all.
    if (!covered || existing.unmodifiable) continue;

    const changed: Record<string, unknown> = {};
    if (existing.title !== node.t) changed.title = node.t;
    if (node.k === "b" && existing.url !== node.u) {
      if (isSyncableUrl(node.u ?? "")) changed.url = node.u;
      else counts.skipped++;
    }
    if (Object.keys(changed).length > 0) {
      updates.push({
        objectType: objectTypeOf(node.k),
        objectId: node.o,
        operationType: "update",
        payload: changed,
        title: node.t,
      });
    }
    if (existing.parentObjectId !== node.p || existing.position !== node.x) {
      moves.push({
        objectType: objectTypeOf(node.k),
        objectId: node.o,
        operationType: "move",
        payload: { parent: node.p, position: node.x },
        title: node.t,
      });
    }
  }

  const deletes: PlannedOperation[] = [];
  if (mode === "exact") {
    // Live nodes the point doesn't hold, within the scope.
    const unwanted = new Set<string>();
    const consider = (node: LiveBookmarkNode) => {
      if (!pointById.has(node.objectId) && !node.unmodifiable) unwanted.add(node.objectId);
    };
    if (scope === "all") {
      for (const node of live) consider(node);
    } else if (liveById.has(scope)) {
      // Only what is inside the folder as it is now.
      const liveChildren = new Map<string, LiveBookmarkNode[]>();
      for (const node of live) {
        const siblings = liveChildren.get(node.parentObjectId);
        if (siblings) siblings.push(node);
        else liveChildren.set(node.parentObjectId, [node]);
      }
      const stack = [scope];
      while (stack.length > 0) {
        for (const child of liveChildren.get(stack.pop()!) ?? []) {
          consider(child);
          if (child.kind === "f") stack.push(child.objectId);
        }
      }
    }
    for (const node of live) {
      // Topmost only: if the parent goes, so does this one.
      if (!unwanted.has(node.objectId) || unwanted.has(node.parentObjectId) || ROOT_IDS.has(node.objectId)) continue;
      deletes.push({
        objectType: objectTypeOf(node.kind),
        objectId: node.objectId,
        operationType: "delete",
        payload: {},
        title: node.title,
      });
    }
  }

  counts.restored = restores.length;
  counts.updated = updates.length;
  counts.moved = moves.length;
  counts.deleted = deletes.length;
  return {
    operations: [...restores, ...updates, ...moves, ...deletes],
    counts,
    sample: {
      restored: restores.slice(0, SAMPLE_SIZE).map((o) => o.title),
      updated: updates.slice(0, SAMPLE_SIZE).map((o) => o.title),
      moved: moves.slice(0, SAMPLE_SIZE).map((o) => o.title),
      deleted: deletes.slice(0, SAMPLE_SIZE).map((o) => o.title),
    },
  };
}
