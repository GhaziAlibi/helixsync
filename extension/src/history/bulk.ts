// Bulk history import (historyVisit / bulkImport, docs/protocol.md §8.3,
// docs/encryption.md §6). First login uploads pre-existing history as a few
// large chunk operations instead of one operation per visit, which pinned
// the service-worker thread on large profiles. Each chunk holds standard §6
// envelopes (one per segment) under the usual SDEK; no new cryptography.
//
// Three different "versions" appear here; only the first is about encryption:
// each segment's envelope `v` (ENVELOPE_VERSION in ../crypto), the container's
// `v`/`bulkVersion`, and the segment plaintext's `v` (1 = flat visits,
// 2 = grouped by URL). The latter two describe data layout and have nothing
// to do with the envelope version.
import { uploadOperations } from "../api/client";
import {
  buildOperationAad,
  decryptBytesWithSdek,
  encryptBytesWithSdek,
  getSdek,
  UnsupportedEnvelopeVersionError,
} from "../crypto";
import type { EncryptionEnvelope } from "../crypto";
import {
  getDevice,
  putDevice,
  reserveSequenceBatch,
} from "../storage/db";
import { isBulkContainer } from "../sync/bulk-container";
import { uploadPending } from "../sync/engine";
import type {
  BulkHistoryContainer,
  BulkSegmentPlaintextV2,
  BulkVisit,
  BulkVisitGroup,
  LocalOperation,
} from "../sync/types";
import { hourKey } from "../util/hour";
import { paceForWork } from "../util/pace";
import { deterministicUuid } from "../util/uuid";
import { yieldToEventLoop } from "../util/yield";

// Visits per encrypted segment. Sets the granularity of encrypt pacing and
// of the peer's decrypt loop.
export let BULK_SEGMENT_VISITS = 10_000;

export function setBulkSegmentVisitsForTesting(n: number): void {
  BULK_SEGMENT_VISITS = n;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// Compression is feature-detected, not version-gated: deflate-raw support in
// a service worker at the minimum Chrome version (116) is unverified. Without
// it the container simply omits `codec` and ships uncompressed.
let deflateSupported: boolean | null = null;
function supportsDeflateRaw(): boolean {
  if (deflateSupported === null) {
    deflateSupported = typeof CompressionStream !== "undefined" && typeof DecompressionStream !== "undefined";
  }
  return deflateSupported;
}

export function resetDeflateSupportForTesting(): void {
  deflateSupported = null;
}

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// A chunk upload can outlast the standard 30s sync timeout.
export const BULK_UPLOAD_TIMEOUT_MS = 300_000;

// Segments are grouped into chunks, each flushed as its own bulkImport op
// and uploaded before collection continues, so memory stays bounded to about
// one chunk. Holding a whole large import in memory OOMs the worker. A chunk
// is flushed at whichever limit is hit first: ciphertext bytes (well under
// the server's 96MB per-op cap) or visit count. The visit cap is needed
// because compressed bytes no longer track visit count, and it bounds how
// much one op or one retry represents.
const BULK_CHUNK_TARGET_BYTES = 20 * 1024 * 1024;
export let BULK_CHUNK_TARGET_VISITS = 100_000;

export function setBulkChunkTargetVisitsForTesting(n: number): void {
  BULK_CHUNK_TARGET_VISITS = n;
}

// The chunk target is checked between segments, so a single pathological
// segment could exceed the server's cap. Fail loudly rather than upload it.
const BULK_HARD_ABORT_BYTES = 90 * 1024 * 1024;

export const HISTORY_IMPORT_TOO_LARGE_MESSAGE =
  "HelixSync history import too large: narrow the history retention window and retry";

// A real pause between chunk uploads lowers the CPU duty cycle of a long
// import (a yield alone wouldn't).
let bulkChunkUploadDelayMs = 750;

export function setBulkChunkUploadDelayMsForTesting(ms: number): void {
  bulkChunkUploadDelayMs = ms;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Paged so a single search never pulls tens of thousands of items across IPC.
export let BULK_SEARCH_PAGE_SIZE = 5_000;

export function setBulkSearchPageSizeForTesting(n: number): void {
  BULK_SEARCH_PAGE_SIZE = n;
}

// getVisits is one IPC round trip per URL; overlap a few at a time.
const BULK_URL_CONCURRENCY = 10;
const BULK_RESOLVE_SUBBATCH = 5;

// auto_subframe visits are never user-initiated browsing. Import only: live
// onVisited events carry no transition.
const NON_USER_VISIT_TRANSITIONS: ReadonlySet<string> = new Set(["auto_subframe"]);

/** Chunk ids derived from (device, scope cutoff, chunk index), so a retry
 * or relogin re-sends the same ids and the server dedups them. A different
 * cutoff is deliberately a different import. */
export async function deterministicBulkIds(
  deviceId: string,
  cutoffMs: number,
  chunkIndex: number,
): Promise<{ operationId: string; objectId: string }> {
  const cutoff = String(cutoffMs);
  const chunk = String(chunkIndex);
  const operationId = await deterministicUuid("HISTORY_BULK", deviceId, "bulkImport", cutoff, chunk);
  const objectId = await deterministicUuid("HISTORY_BULK", deviceId, "bulkImport", cutoff, chunk, "object");
  return { operationId, objectId };
}

// One URL's visit times (epoch ms) within a segment. A URL whose visits
// straddle a segment boundary is split across segments.
interface CollectedGroup {
  url: string;
  title?: string;
  times: number[];
}

/** Largest value in ascending `sorted` strictly below `bound`, if any. */
function largestBelow(sorted: Float64Array, bound: number): number | undefined {
  let lo = 0;
  let hi = sorted.length - 1;
  let result: number | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < bound) {
      result = sorted[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result;
}

/** Streams every visit in `[cutoffMs, endMs)` into segments of
 * BULK_SEGMENT_VISITS. Returns aborted:true if the device disconnects.
 *
 * Paging: a search result's `lastVisitTime` is the URL's overall last visit,
 * not the one inside the queried window, so it can't be the next page's
 * `endTime` without skipping URLs. `urlTimes` keeps each URL's sorted
 * in-window times (~8 bytes per visit); the next cursor is the largest of the
 * last item's times below the current bound. That skips nothing and always
 * makes progress. Together with the fixed window it makes enumeration
 * deterministic, which the skip-by-count resume depends on. */
async function enumerateVisits(
  cutoffMs: number,
  endMs: number,
  skipState: { remaining: number },
  onSegment: (groups: CollectedGroup[]) => Promise<void>,
): Promise<{ total: number; aborted: boolean }> {
  let total = 0;
  let pending: CollectedGroup[] = [];
  // The segment cap counts visits, not groups.
  let pendingVisitCount = 0;

  async function flushSegment(): Promise<void> {
    if (pendingVisitCount === 0) return;
    const segment = pending;
    pending = [];
    total += pendingVisitCount;
    pendingVisitCount = 0;
    await onSegment(segment);
  }

  // Resume: visits already covered by uploaded chunks are dropped before
  // they're serialized or encrypted. The stream order is deterministic, so
  // skipping the first `skipState.remaining` lands on the same boundary.
  async function pushGroup(url: string, title: string | undefined, times: number[]): Promise<void> {
    if (skipState.remaining > 0) {
      const skip = Math.min(skipState.remaining, times.length);
      times = times.slice(skip);
      skipState.remaining -= skip;
      if (times.length === 0) return;
    }
    let offset = 0;
    while (offset < times.length) {
      const room = BULK_SEGMENT_VISITS - pendingVisitCount;
      const take = Math.min(room, times.length - offset);
      pending.push({ url, title, times: times.slice(offset, offset + take) });
      pendingVisitCount += take;
      offset += take;
      if (pendingVisitCount >= BULK_SEGMENT_VISITS) {
        await flushSegment();
      }
    }
  }

  let queryEndTime = endMs;
  let pageIndex = 0;
  const urlTimes = new Map<string, Float64Array>();
  for (;;) {
    if (!(await getDevice())) {
      console.log("HelixSync: bulk history enumerate aborted (device disconnected)", { pageIndex, total });
      return { total, aborted: true };
    }
    const searchStartedAt = Date.now();
    const items = await chrome.history.search({
      text: "",
      startTime: cutoffMs,
      endTime: queryEndTime,
      maxResults: BULK_SEARCH_PAGE_SIZE,
    });
    // Paces only this call's own wait. Pacing a whole page's nested work
    // would compound into sleeps long enough to get the worker idle-killed.
    await paceForWork(Date.now() - searchStartedAt);
    console.log("HelixSync: bulk history search page", {
      pageIndex,
      itemsInPage: items.length,
      queryEndTime,
      totalSoFar: total + pendingVisitCount,
    });
    pageIndex++;

    for (let i = 0; i < items.length; i += BULK_URL_CONCURRENCY) {
      const slice = items.slice(i, i + BULK_URL_CONCURRENCY);
      const inWindow = slice.filter(
        (item) =>
          item.url &&
          !urlTimes.has(item.url) &&
          (item.lastVisitTime ?? Number.POSITIVE_INFINITY) >= cutoffMs,
      );
      if (inWindow.length === 0) continue;
      // Reserved before the async getVisits calls so a URL resurfacing in
      // the next slice is never enumerated twice.
      for (const item of inWindow) urlTimes.set(item.url!, new Float64Array(0));
      for (let k = 0; k < inWindow.length; k += BULK_RESOLVE_SUBBATCH) {
        if (!(await getDevice())) return { total, aborted: true };
        const group = inWindow.slice(k, k + BULK_RESOLVE_SUBBATCH);
        const subBatchStartedAt = Date.now();
        const groupsPerUrl = await Promise.all(
          group.map(async (item) => {
            const visits = await chrome.history.getVisits({ url: item.url! });
            const times: number[] = [];
            for (const visit of visits) {
              // Never stamp a missing visitTime as "now".
              if (visit.visitTime === undefined) continue;
              const visitTime = visit.visitTime;
              if (visitTime < cutoffMs || visitTime >= endMs) continue;
              if (NON_USER_VISIT_TRANSITIONS.has(visit.transition ?? "")) continue;
              times.push(visitTime);
            }
            times.sort((a, b) => a - b);
            return { url: item.url!, title: item.title, times };
          }),
        );
        await paceForWork(Date.now() - subBatchStartedAt);
        for (const g of groupsPerUrl) {
          urlTimes.set(g.url, Float64Array.from(g.times));
          if (g.times.length === 0) continue;
          await pushGroup(g.url, g.title, g.times);
        }
      }
      await yieldToEventLoop();
    }

    if (items.length < BULK_SEARCH_PAGE_SIZE) break;

    const lastItem = items[items.length - 1];
    const lastItemTimes = (lastItem.url && urlTimes.get(lastItem.url)) || new Float64Array(0);
    let nextQueryEndTime = largestBelow(lastItemTimes, queryEndTime);
    if (nextQueryEndTime === undefined) {
      console.warn("HelixSync: bulk history page cursor found no in-window time below the current bound", {
        pageIndex,
        queryEndTime,
        lastItemUrl: lastItem.url,
      });
      nextQueryEndTime = queryEndTime - 1;
    }
    if (!(nextQueryEndTime < queryEndTime)) {
      console.error("HelixSync: bulk history paging cursor failed to make progress, stopping", {
        pageIndex,
        queryEndTime,
        nextQueryEndTime,
      });
      break;
    }
    queryEndTime = nextQueryEndTime;
  }
  await flushSegment();
  console.log("HelixSync: bulk history enumerate finished", { pages: pageIndex, total });
  return { total, aborted: false };
}

export interface BulkCollectResult {
  chunkCount: number;
  totalVisitCount: number;
  aborted: boolean;
}

/** Carries the chunk's ciphertext size for logging, so the payload isn't
 * serialized a second time just to measure it. */
interface BulkChunkOperation extends LocalOperation {
  chunkBytes: number;
}

// Page-granularity resume fields written by older builds; read only to
// migrate an import that was in progress.
interface LegacyResumeFields {
  historyBulkResumePageEndTime?: number;
  historyBulkResumePreviousPageEndTime?: number;
  historyBulkResumeChunkIndex?: number;
}

/** Collects history into bulkImport chunk ops and awaits `onChunk` for each
 * before continuing, so at most one chunk is resident. On disconnect
 * (`aborted`), chunks already uploaded stay (each is idempotent) and the
 * partial chunk is discarded. */
export async function collectHistoryBulk(
  cutoffMs: number,
  endMs: number,
  onChunk: (operation: BulkChunkOperation) => Promise<void>,
): Promise<BulkCollectResult> {
  const device = await getDevice();
  if (!device) return { chunkCount: 0, totalVisitCount: 0, aborted: false };

  // A persisted scope always wins, so a retry derives the same chunk ids.
  const effectiveCutoff =
    device.historyBulkCutoffMs !== undefined ? device.historyBulkCutoffMs : cutoffMs;
  let effectiveEndMs = device.historyBulkEndMs !== undefined ? device.historyBulkEndMs : endMs;

  // An import started by an older build (old resume fields, or a cutoff
  // without an end) restarts from chunk 0 with the end fixed at now. Chunks
  // already sent re-derive the same ids and are deduplicated by the server.
  const legacy = device as typeof device & LegacyResumeFields;
  const isLegacyInProgress =
    legacy.historyBulkResumePageEndTime !== undefined ||
    legacy.historyBulkResumePreviousPageEndTime !== undefined ||
    legacy.historyBulkResumeChunkIndex !== undefined ||
    (device.historyBulkCutoffMs !== undefined && device.historyBulkEndMs === undefined);

  let uploadedChunks = device.historyBulkUploadedChunks ?? 0;
  let uploadedVisits = device.historyBulkUploadedVisits ?? 0;

  if (isLegacyInProgress) {
    effectiveEndMs = Date.now();
    uploadedChunks = 0;
    uploadedVisits = 0;
    const current = await getDevice();
    if (current) {
      const migrated = { ...current } as typeof current & LegacyResumeFields;
      delete migrated.historyBulkResumePageEndTime;
      delete migrated.historyBulkResumePreviousPageEndTime;
      delete migrated.historyBulkResumeChunkIndex;
      migrated.historyBulkEndMs = effectiveEndMs;
      migrated.historyBulkUploadedChunks = undefined;
      migrated.historyBulkUploadedVisits = undefined;
      await putDevice(migrated);
    }
    console.log("HelixSync: bulk history migrated legacy in-progress device record", {
      effectiveCutoff,
      effectiveEndMs,
    });
  }

  const startedAt = Date.now();
  console.log("HelixSync: bulk history collect starting", {
    cutoffMs,
    effectiveCutoff,
    effectiveEndMs,
    cutoffAgeDays: (Date.now() - effectiveCutoff) / 86_400_000,
    resuming: uploadedChunks > 0,
    uploadedChunks,
    uploadedVisits,
  });

  const sdek = await getSdek(device.accountKey, device.accountKeyVersion);
  const keyVersion = device.accountKeyVersion;
  // Decided once so every segment in this run agrees.
  const codec: "deflate-raw" | undefined = supportsDeflateRaw() ? "deflate-raw" : undefined;

  let chunkSegments: EncryptionEnvelope[] = [];
  let chunkVisitCount = 0;
  let chunkBytes = 0;
  // Per-hour visit counts (docs/protocol.md §8.3.2) for the chunk being
  // built. Counted from the segments themselves, after resume skipping, so a
  // resumed run doesn't recount visits already uploaded.
  let chunkVisitHours = new Map<string, number>();
  let chunkIndex = uploadedChunks;
  let totalVisitCount = 0;
  let chunksFlushedThisRun = 0;
  // F-02: every segment is bound (via AEAD AAD) to the objectId its chunk
  // will upload under, so a malicious server can't splice a segment into a
  // different bulk operation. Deterministic in (deviceId, cutoff, chunkIndex)
  // and stable for as long as chunkIndex is, so it's computed once per chunk.
  let currentChunkObjectId: string | undefined;

  // MV3 keep-alive: sleeps don't count as activity for the ~30s idle timer,
  // so a trivial extension API call on a steady cadence keeps a long import
  // from being killed.
  const keepAliveIntervalId = setInterval(() => {
    chrome.runtime.getPlatformInfo(() => {
      void chrome.runtime.lastError; // acknowledge to avoid an "unchecked" warning
    });
  }, 20_000);

  const flushChunk = async (): Promise<void> => {
    if (chunkVisitCount === 0) return;
    // This chunk uploads directly, bypassing the pending queue. Anything
    // already queued has a lower device sequence; if this chunk were accepted
    // first, the server would reject those as sequence_conflict and they'd
    // be dropped for good. So drain the queue before reserving a sequence.
    for (let more = true; more; ) {
      more = await uploadPending();
    }
    const { operationId, objectId } = await deterministicBulkIds(device.deviceId, effectiveCutoff, chunkIndex);
    const { startDeviceSequence, startLamport } = await reserveSequenceBatch(1);
    const container: BulkHistoryContainer = {
      v: 1,
      bulkVersion: 2,
      codec,
      visitCount: chunkVisitCount,
      segments: chunkSegments,
    };
    // The server rejects a histogram that doesn't sum to visitCount, so a
    // mismatch fails here, loudly.
    let visitHoursSum = 0;
    for (const count of chunkVisitHours.values()) visitHoursSum += count;
    if (visitHoursSum !== chunkVisitCount) {
      console.error("HelixSync: bulk history chunk visitHours sum mismatch", {
        chunkIndex,
        visitHoursSum,
        chunkVisitCount,
      });
      throw new Error("HelixSync: bulk history chunk visitHours sum mismatch");
    }
    const operation: BulkChunkOperation = {
      operationId,
      deviceSequence: startDeviceSequence + 1,
      lamportTimestamp: startLamport + 1,
      objectType: "historyVisit",
      objectId,
      operationType: "bulkImport",
      encryptionVersion: 1,
      payload: container,
      visitCount: chunkVisitCount,
      visitHours: Object.fromEntries(chunkVisitHours),
      chunkBytes,
    };
    console.log("HelixSync: bulk history chunk ready", {
      chunkIndex,
      visitCount: chunkVisitCount,
      segments: chunkSegments.length,
      bytes: chunkBytes,
    });
    const thisChunkVisitCount = chunkVisitCount;
    totalVisitCount += chunkVisitCount;
    chunkIndex += 1;
    chunksFlushedThisRun += 1;
    chunkSegments = [];
    chunkVisitCount = 0;
    chunkVisitHours = new Map();
    chunkBytes = 0;
    currentChunkObjectId = undefined;
    await onChunk(operation);
    // Checkpoint only after the upload succeeded. Dying before this write
    // just re-sends one chunk, which the server dedups.
    uploadedChunks = chunkIndex;
    uploadedVisits += thisChunkVisitCount;
    const current = await getDevice();
    if (current) {
      await putDevice({
        ...current,
        historyBulkUploadedChunks: uploadedChunks,
        historyBulkUploadedVisits: uploadedVisits,
      });
    }
    console.log("HelixSync: bulk history checkpoint persisted", { uploadedChunks, uploadedVisits });
    await sleep(bulkChunkUploadDelayMs);
  };

  let aborted = false;
  try {
    const skipState = { remaining: uploadedVisits };
    ({ aborted } = await enumerateVisits(
      effectiveCutoff,
      effectiveEndMs,
      skipState,
      async (groups) => {
        // Compression and encryption are the main CPU cost, so their
        // measured duration is paced.
        const plaintext: BulkSegmentPlaintextV2 = {
          v: 2,
          groups: groups.map((g) => ({ u: g.url, t: g.title, v: g.times })),
        };
        let visitCount = 0;
        for (const g of groups) visitCount += g.times.length;
        for (const g of groups) {
          for (const t of g.times) {
            const key = hourKey(t);
            chunkVisitHours.set(key, (chunkVisitHours.get(key) ?? 0) + 1);
          }
        }
        const jsonBytes = textEncoder.encode(JSON.stringify(plaintext));
        const encryptStartedAt = Date.now();
        const plaintextBytes = codec === "deflate-raw" ? await deflateRaw(jsonBytes) : jsonBytes;
        if (currentChunkObjectId === undefined) {
          currentChunkObjectId = (
            await deterministicBulkIds(device.deviceId, effectiveCutoff, chunkIndex)
          ).objectId;
        }
        const envelope = encryptBytesWithSdek(
          plaintextBytes,
          sdek,
          keyVersion,
          buildOperationAad("historyVisit", currentChunkObjectId, "bulkImport"),
        );
        const encryptMs = Date.now() - encryptStartedAt;
        if (envelope.ciphertext.length > BULK_HARD_ABORT_BYTES) {
          console.error("HelixSync: bulk history single segment exceeds hard cap", {
            ciphertextBytes: envelope.ciphertext.length,
          });
          throw new Error(HISTORY_IMPORT_TOO_LARGE_MESSAGE);
        }
        chunkSegments.push(envelope);
        chunkVisitCount += visitCount;
        chunkBytes += envelope.ciphertext.length;
        if (chunkBytes >= BULK_CHUNK_TARGET_BYTES || chunkVisitCount >= BULK_CHUNK_TARGET_VISITS) {
          await flushChunk();
        }
        await yieldToEventLoop();
        await paceForWork(encryptMs);
      },
    ));

    if (!aborted) {
      await flushChunk();
      // Complete: clear the checkpoint but keep the scope.
      const current = await getDevice();
      if (current) {
        await putDevice({
          ...current,
          historyBulkUploadedChunks: undefined,
          historyBulkUploadedVisits: undefined,
        });
      }
    }
  } finally {
    clearInterval(keepAliveIntervalId);
  }

  console.log("HelixSync: bulk history collect finished", {
    totalVisitCount,
    chunksFlushedThisRun,
    nextChunkIndex: chunkIndex,
    aborted,
    elapsedMs: Date.now() - startedAt,
  });

  return { chunkCount: chunksFlushedThisRun, totalVisitCount, aborted };
}

/** Uploads one chunk op with the raised bulk timeout. Accepted or duplicate
 * is success; payload_too_large asks the user to narrow retention. */
export async function uploadHistoryBulk(operation: BulkChunkOperation): Promise<void> {
  const device = await getDevice();
  if (!device) return;
  await putDevice({
    ...device,
    historyBulkOperationId: operation.operationId,
    historyBulkObjectId: operation.objectId,
  });

  const payloadBytes = operation.chunkBytes;
  console.log("HelixSync: bulk history upload starting", {
    operationId: operation.operationId,
    visitCount: operation.visitCount,
    payloadBytes,
  });
  const uploadStartedAt = Date.now();
  let response;
  try {
    response = await uploadOperations([operation], BULK_UPLOAD_TIMEOUT_MS);
  } catch (e) {
    console.error("HelixSync: bulk history upload request failed", e, {
      elapsedMs: Date.now() - uploadStartedAt,
    });
    throw e;
  }
  console.log("HelixSync: bulk history upload response", {
    elapsedMs: Date.now() - uploadStartedAt,
    accepted: response.accepted,
    duplicate: response.duplicate,
    rejected: response.rejected,
  });
  if (response.accepted.includes(operation.operationId)) return;
  if (response.duplicate.includes(operation.operationId)) return;
  const rejection = response.rejected.find((r) => r.operationId === operation.operationId);
  if (rejection?.reason === "payload_too_large") {
    throw new Error(HISTORY_IMPORT_TOO_LARGE_MESSAGE);
  }
  if (rejection) {
    throw new Error(`HelixSync history import rejected: ${rejection.reason}`);
  }
  throw new Error("HelixSync history import failed: no acceptance from server");
}

/** One-time bulk import scoped from `cutoffMs`, uploading each chunk as it's
 * ready. Returns without throwing on disconnect. */
export async function backfillHistoryBulk(cutoffMs: number): Promise<void> {
  console.log("HelixSync: backfillHistoryBulk called", { cutoffMs });
  const device = await getDevice();
  if (!device) {
    console.log("HelixSync: backfillHistoryBulk skipped (no device)");
    return;
  }
  // The scope is persisted once, before collecting, so every retry derives
  // the same chunk ids. `historyBulkEndMs` is normally already set before
  // live capture starts; `Date.now()` is only a fallback so the import never
  // runs without an end bound.
  const effectiveCutoff =
    device.historyBulkCutoffMs !== undefined ? device.historyBulkCutoffMs : cutoffMs;
  const effectiveEndMs = device.historyBulkEndMs !== undefined ? device.historyBulkEndMs : Date.now();
  if (device.historyBulkCutoffMs === undefined) {
    const current = await getDevice();
    if (!current) {
      console.log("HelixSync: backfillHistoryBulk skipped (device gone before cutoff persist)");
      return;
    }
    await putDevice({ ...current, historyBulkCutoffMs: effectiveCutoff, historyBulkEndMs: effectiveEndMs });
  }
  const result = await collectHistoryBulk(effectiveCutoff, effectiveEndMs, async (operation) => {
    if (!(await getDevice())) {
      console.log("HelixSync: backfillHistoryBulk skipped chunk upload (device gone)", {
        objectId: operation.objectId,
      });
      return;
    }
    await uploadHistoryBulk(operation);
  });
  console.log("HelixSync: backfillHistoryBulk finished", result);
}

// --- Peer expansion -----------------------------------------------------

export { isBulkContainer };

// Epoch-ms `t`, as stored in a v2 segment.
interface DecryptedEntry {
  url: string;
  title?: string;
  t: number;
}

interface DecryptedSegment {
  entries: DecryptedEntry[];
}

/** Decodes `{v:2, groups}` or `{v:1, visits}` (also a bare `{visits}`)
 * segment plaintext into one entry per visit. */
function decodeSegmentPlaintext(plaintext: Record<string, unknown>): DecryptedSegment | null {
  if (plaintext["v"] === 2) {
    const groups = (plaintext as { groups?: BulkVisitGroup[] }).groups;
    if (!Array.isArray(groups)) return null;
    const entries: DecryptedEntry[] = [];
    for (const g of groups) {
      if (typeof g.u !== "string" || !Array.isArray(g.v)) continue;
      for (const t of g.v) entries.push({ url: g.u, title: g.t, t });
    }
    return { entries };
  }
  const visits = (plaintext as { visits?: BulkVisit[] }).visits;
  if (!Array.isArray(visits)) return null;
  const entries: DecryptedEntry[] = [];
  for (const visit of visits) {
    entries.push({ url: visit.url, title: visit.title, t: new Date(visit.visitedAt).getTime() });
  }
  return { entries };
}

/** Decrypts (and inflates, if the container's `codec` says so) one segment.
 * Returns null for anything that fails, so one bad segment is skipped rather
 * than aborting the expansion.
 *
 * SEC-13: a segment without `ciphertext` is rejected, never read as
 * plaintext. This client always encrypts, so such a segment means a broken
 * or malicious server. */
async function decryptSegment(
  segment: unknown,
  rekB64: string,
  codec: "deflate-raw" | undefined,
  objectId: string,
): Promise<DecryptedSegment | null> {
  try {
    if (typeof segment !== "object" || segment === null) return null;
    if (!("ciphertext" in segment)) return null;
    const envelope = segment as EncryptionEnvelope;
    const sdek = await getSdek(rekB64, envelope.keyVersion);
    const aad = buildOperationAad("historyVisit", objectId, "bulkImport");
    const decryptedBytes = decryptBytesWithSdek(envelope, sdek, aad);
    const plaintextBytes = codec === "deflate-raw" ? await inflateRaw(decryptedBytes) : decryptedBytes;
    const plaintext = JSON.parse(textDecoder.decode(plaintextBytes)) as Record<string, unknown>;
    return decodeSegmentPlaintext(plaintext);
  } catch (err) {
    // Unlike a corrupt or tampered segment, an envelope from another format
    // is not "bad data to skip"; let it stop the sync (see engine.ts).
    if (err instanceof UnsupportedEnvelopeVersionError) throw err;
    return null;
  }
}

/** Calls `onVisit` for every visit in a container, one segment at a time.
 * Every segment is decrypted, but only one is resident at once, so memory is
 * bounded by BULK_SEGMENT_VISITS however large the import is. Returns false,
 * having stopped early, if `isAborted` reports true. */
export async function forEachBulkVisit(
  container: BulkHistoryContainer,
  rekB64: string,
  onVisit: (url: string, timeMs: number, title: string | undefined) => void,
  isAborted: () => Promise<boolean>,
  objectId: string,
): Promise<boolean> {
  // v1 containers have no `codec` field; absent means uncompressed.
  const codec = "codec" in container ? container.codec : undefined;
  for (const segment of container.segments) {
    if (await isAborted()) return false;
    const decryptStartedAt = Date.now();
    const decrypted = await decryptSegment(segment, rekB64, codec, objectId);
    await paceForWork(Date.now() - decryptStartedAt);
    if (!decrypted) continue;
    for (const entry of decrypted.entries) onVisit(entry.url, entry.t, entry.title);
    await yieldToEventLoop();
  }
  return true;
}
