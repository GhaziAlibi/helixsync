// Client-side deterministic conflict resolution per docs/protocol.md §8.
// This is THE place both bookmarks/history/tabs modules must go through to
// decide whether an incoming remote field value should actually be applied
// — never call chrome.* mutators directly from a downloaded operation
// without going through here, or server_cursor delivery order (which is
// NOT causal order, docs/protocol.md §4.3) can silently produce
// non-deterministic results that diverge between devices.
import type { IDBPTransaction } from "idb";
import { fieldStateKey, getDb, getFieldState, putFieldState, type FieldStateRecord, type HelixSyncDB } from "../storage/db";
import type { OperationType } from "./types";

export interface OrderingKey {
  lamportTimestamp: number;
  deviceId: string;
  operationId: string;
}

/** docs/protocol.md §8.1 universal ordering: (lamportTimestamp, deviceId,
 * operationId) compared lexicographically, higher wins. Returns >0 if a
 * wins, <0 if b wins, 0 only if truly identical (same operationId). */
export function compareOrderingKey(a: OrderingKey, b: OrderingKey): number {
  if (a.lamportTimestamp !== b.lamportTimestamp) {
    return a.lamportTimestamp - b.lamportTimestamp;
  }
  if (a.deviceId !== b.deviceId) {
    return a.deviceId < b.deviceId ? -1 : 1;
  }
  if (a.operationId !== b.operationId) {
    return a.operationId < b.operationId ? -1 : 1;
  }
  return 0;
}

export interface IncomingField extends OrderingKey {
  operationType: OperationType;
  value: unknown;
}

export interface ResolveResult {
  applied: boolean;
  value: unknown;
}

type FieldStateTx = IDBPTransaction<HelixSyncDB, ["field_state"], "readwrite">;

/**
 * Resolve a single (objectId, field) slot against its current provenance,
 * against an already-open transaction — the shared core behind both
 * `resolveField` (opens its own single-field transaction) and
 * `resolveFields` (resolves several fields in one transaction). See
 * `resolveField`'s docs for the actual arbitration rules; this only
 * factors out where the IndexedDB reads/writes happen.
 */
async function resolveFieldInTx(
  tx: FieldStateTx,
  objectId: string,
  field: string,
  incoming: IncomingField,
): Promise<ResolveResult> {
  const store = tx.objectStore("field_state");
  const key = fieldStateKey(objectId, field);
  const current = await store.get(key);

  if (!current) {
    await store.put({ key, objectId, field, ...incoming } as FieldStateRecord);
    return { applied: true, value: incoming.value };
  }

  if (field === "liveness") {
    if (incoming.operationType === "delete" && current.operationType === "move") {
      await store.put({ key, objectId, field, ...incoming } as FieldStateRecord);
      return { applied: true, value: incoming.value };
    }
    if (incoming.operationType === "move" && current.value === "deleted") {
      return { applied: false, value: current.value };
    }
  }

  const cmp = compareOrderingKey(incoming, {
    lamportTimestamp: current.lamportTimestamp,
    deviceId: current.deviceId,
    operationId: current.operationId,
  });

  if (cmp > 0) {
    await store.put({ key, objectId, field, ...incoming } as FieldStateRecord);
    return { applied: true, value: incoming.value };
  }
  return { applied: false, value: current.value };
}

/**
 * Resolve a single (objectId, field) slot against its current provenance.
 *
 * Every mutable field (title, url, the compound move field, and the
 * special "liveness" field used to arbitrate create/update/move/delete/
 * restore per docs/protocol.md §8.2) goes through the same generic
 * §8.1 LWW rule, with one documented asymmetric exception for `liveness`:
 * "Delete vs move: delete wins" unconditionally (unlike "Delete vs
 * update", which is ordering-dependent), so that one case is
 * special-cased rather than falling through to plain §8.1 compare.
 */
export async function resolveField(
  objectId: string,
  field: string,
  incoming: IncomingField,
): Promise<ResolveResult> {
  const db = await getDb();
  const tx = db.transaction("field_state", "readwrite");
  const result = await resolveFieldInTx(tx, objectId, field, incoming);
  await tx.done;
  return result;
}

export interface FieldResolution {
  field: string;
  incoming: IncomingField;
}

/**
 * Batch counterpart to `resolveField`: resolves several (objectId, field)
 * slots in one IndexedDB transaction instead of one per field, cutting the
 * number of committed transactions an applier needs for e.g. a bookmark
 * `create` (title + url + move + liveness) from 4 to 1. Only safe — and
 * only used — where nothing needs to observe one field's resolution
 * before another is resolved; in particular, callers must not put a
 * chrome.* mutation between entries, since each field's own LWW result
 * never depends on another field's, only on its own prior state. Results
 * are returned in the same order as `entries`.
 */
export async function resolveFields(
  objectId: string,
  entries: FieldResolution[],
): Promise<ResolveResult[]> {
  const db = await getDb();
  const tx = db.transaction("field_state", "readwrite");
  const results: ResolveResult[] = [];
  for (const { field, incoming } of entries) {
    results.push(await resolveFieldInTx(tx, objectId, field, incoming));
  }
  await tx.done;
  return results;
}

/** Seed field provenance for an operation this device just originated. Our
 * own writes participate in the same §8.1 arbitration domain as remote
 * ones — without this, a remote operation with a lower ordering key could
 * later be compared against nothing and incorrectly "win" against a
 * pending local change that hasn't round-tripped through the server yet. */
export async function recordLocalFieldState(
  objectId: string,
  field: string,
  key: OrderingKey & { operationType: OperationType },
  value: unknown,
): Promise<void> {
  await putFieldState({ objectId, field, ...key, value });
}

export function isLive(objectId: string): Promise<ResolveResult | undefined> {
  return getFieldState(objectId, "liveness").then((s) =>
    s ? { applied: true, value: s.value } : undefined,
  );
}
