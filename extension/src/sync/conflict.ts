// Deterministic conflict resolution (docs/protocol.md §8). Every remote
// field value must be arbitrated here before touching the browser: server
// cursor order is delivery order, not causal order (§4.3), so applying
// operations directly would let devices diverge.
import type { IDBPTransaction } from "idb";
import {
  fieldStateKey,
  getDb,
  putFieldState,
  putFieldStatesBatch,
  type FieldStateRecord,
  type HelixSyncDB,
} from "../storage/db";
import type { OperationType } from "./types";

export interface OrderingKey {
  lamportTimestamp: number;
  deviceId: string;
  operationId: string;
}

/** docs/protocol.md §8.1: (lamportTimestamp, deviceId, operationId) compared
 * lexicographically, higher wins. >0 if a wins, <0 if b wins, 0 only for the
 * same operation. */
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

const IDB_BATCH_CHUNK = 200;

function buildNextState(
  objectId: string,
  field: string,
  incoming: IncomingField,
  recordedAt: number,
): FieldStateRecord {
  return { key: fieldStateKey(objectId, field), objectId, field, ...incoming, recordedAt } as FieldStateRecord;
}

/** Plain §8.1 last-writer-wins, with one exception for "liveness": delete
 * beats move unconditionally, and a move never revives a deleted object.
 * `recordedAt` is bookkeeping for GC only and never affects the outcome. */
function arbitrateField(
  current: FieldStateRecord | undefined,
  objectId: string,
  field: string,
  incoming: IncomingField,
  recordedAt: number,
): { result: ResolveResult; next: FieldStateRecord | undefined } {
  if (!current) {
    const next = buildNextState(objectId, field, incoming, recordedAt);
    return { result: { applied: true, value: incoming.value }, next };
  }

  if (field === "liveness") {
    if (incoming.operationType === "delete" && current.operationType === "move") {
      const next = buildNextState(objectId, field, incoming, recordedAt);
      return { result: { applied: true, value: incoming.value }, next };
    }
    if (incoming.operationType === "move" && current.value === "deleted") {
      return { result: { applied: false, value: current.value }, next: undefined };
    }
  }

  const cmp = compareOrderingKey(incoming, {
    lamportTimestamp: current.lamportTimestamp,
    deviceId: current.deviceId,
    operationId: current.operationId,
  });

  if (cmp > 0) {
    const next = buildNextState(objectId, field, incoming, recordedAt);
    return { result: { applied: true, value: incoming.value }, next };
  }
  return { result: { applied: false, value: current.value }, next: undefined };
}

/** One batched read, an in-memory walk in array order, then one batched
 * write of the winners. A repeated (objectId, field) sees the earlier
 * entry's result, exactly as sequential resolution would. */
async function resolveEntriesInTx(
  tx: FieldStateTx,
  entries: BatchFieldResolution[],
): Promise<ResolveResult[]> {
  const store = tx.objectStore("field_state");
  const keys = entries.map((e) => fieldStateKey(e.objectId, e.field));
  const distinctKeys = [...new Set(keys)];

  const currentByKey = new Map<string, FieldStateRecord | undefined>();
  for (let i = 0; i < distinctKeys.length; i += IDB_BATCH_CHUNK) {
    const slice = distinctKeys.slice(i, i + IDB_BATCH_CHUNK);
    const fetched = await Promise.all(slice.map((k) => store.get(k)));
    fetched.forEach((rec, j) => currentByKey.set(slice[j], rec));
  }

  const results: ResolveResult[] = [];
  const pendingWrites = new Map<string, FieldStateRecord>();
  const recordedAt = Date.now();
  for (let i = 0; i < entries.length; i++) {
    const { objectId, field, incoming } = entries[i];
    const key = keys[i];
    const current = currentByKey.get(key);
    const { result, next } = arbitrateField(current, objectId, field, incoming, recordedAt);
    results.push(result);
    if (next) {
      currentByKey.set(key, next);
      pendingWrites.set(key, next);
    }
  }

  // Only each key's final winner is observable after the transaction.
  const pendingList = [...pendingWrites.values()];
  for (let i = 0; i < pendingList.length; i += IDB_BATCH_CHUNK) {
    await Promise.all(pendingList.slice(i, i + IDB_BATCH_CHUNK).map((rec) => store.put(rec)));
  }
  return results;
}

async function resolveInTransaction(entries: BatchFieldResolution[]): Promise<ResolveResult[]> {
  const db = await getDb();
  const tx = db.transaction("field_state", "readwrite");
  const results = await resolveEntriesInTx(tx, entries);
  await tx.done;
  return results;
}

/** Resolves one (objectId, field) slot against its recorded provenance. */
export async function resolveField(
  objectId: string,
  field: string,
  incoming: IncomingField,
): Promise<ResolveResult> {
  const [result] = await resolveInTransaction([{ objectId, field, incoming }]);
  return result;
}

export interface FieldResolution {
  field: string;
  incoming: IncomingField;
}

/** Resolves several fields of one object in one transaction. Only valid
 * when no chrome.* mutation needs to happen between fields; results are in
 * `entries` order. */
export async function resolveFields(
  objectId: string,
  entries: FieldResolution[],
): Promise<ResolveResult[]> {
  return resolveInTransaction(entries.map(({ field, incoming }) => ({ objectId, field, incoming })));
}

export interface BatchFieldResolution {
  objectId: string;
  field: string;
  incoming: IncomingField;
}

/** Resolves slots across many objects in one transaction. Entries must be in
 * wire order; callers resolve first and apply the winners' browser
 * mutations afterwards. Results are in `entries` order. */
export async function resolveFieldsBatch(entries: BatchFieldResolution[]): Promise<ResolveResult[]> {
  if (entries.length === 0) return [];
  return resolveInTransaction(entries);
}

/** Seeds provenance for an operation this device just created, so an older
 * remote operation can't later win against a local change that hasn't
 * round-tripped through the server yet. */
export async function recordLocalFieldState(
  objectId: string,
  field: string,
  key: OrderingKey & { operationType: OperationType },
  value: unknown,
): Promise<void> {
  await putFieldState({ objectId, field, ...key, value });
}

export interface LocalFieldStateEntry {
  objectId: string;
  field: string;
  key: OrderingKey & { operationType: OperationType };
  value: unknown;
}

export async function recordLocalFieldStatesBatch(entries: LocalFieldStateEntry[]): Promise<void> {
  await putFieldStatesBatch(entries.map(({ objectId, field, key, value }) => ({ objectId, field, ...key, value })));
}
