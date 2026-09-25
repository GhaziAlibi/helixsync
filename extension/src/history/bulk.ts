// Single-operation history import (historyVisit / bulkImport,
// docs/protocol.md §8.3, docs/encryption.md §6): first login sends old
// history as one op, one POST, one server row, one device-sequence number —
// replacing the per-visit backfill (one getVisits IPC per URL + one SHA-256
// + one AEAD per visit, 500-op chunks, 50 batches/cycle) that pins the MV3
// thread on lifetime profiles.
//
// Live per-visit capture (onVisited → createLocalOperationsBatch) stays
// unchanged; steady state is cheap. Bookmarks backfill stays unchanged.
//
// No new cryptography: N standard encryption.md §6 envelopes inside one op,
// same SDEK, same xchacha20poly1305.
import { uploadOperations } from "../api/client";
import { decryptBytesWithSdek, encryptBytesWithSdek, getSdek } from "../crypto";
import type { EncryptionEnvelope } from "../crypto";
import {
  getDevice,
  putDevice,
  reserveSequenceBatch,
} from "../storage/db";
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

// Per-segment plaintext (pre-encryption): ~10k visits per segment. Exact
// cap pending one real-profile measurement (spec §9). Unaffected by
// compression (spec §D) below: this bounds encrypt-pacing granularity on
// the producer side and the peer decrypt-loop's step size in
// expandBulkNewestK, neither of which is a function of how small the
// resulting ciphertext bytes are.
export let BULK_SEGMENT_VISITS = 10_000;

/** Test-only: overrides BULK_SEGMENT_VISITS so a fixture can exercise
 * multi-segment/multi-page/multi-chunk behavior without a real
 * hundred-thousand-visit fixture. Same pattern as
 * setBulkChunkUploadDelayMsForTesting. */
export function setBulkSegmentVisitsForTesting(n: number): void {
  BULK_SEGMENT_VISITS = n;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// --- Compression (spec §D) -------------------------------------------
//
// Feature-detected, never version-gated: manifest.json declares
// minimum_chrome_version 116, and whether CompressionStream("deflate-raw")
// is available in the MV3 service worker at that version was never verified
// (spec §7 open questions). A producer that can't confirm support omits
// `codec` from the container entirely rather than guessing — the container
// format already expresses "uncompressed" as an absent field (see
// BulkHistoryContainerV2 in sync/types.ts), so a missing codec is a smaller
// win, never a failed import.
let deflateSupported: boolean | null = null;
function supportsDeflateRaw(): boolean {
  if (deflateSupported === null) {
    deflateSupported = typeof CompressionStream !== "undefined" && typeof DecompressionStream !== "undefined";
  }
  return deflateSupported;
}

/** Test-only: clears the cached feature-detect result. Same convention as
 *  resetB64DetectionForTesting in crypto/index.ts. */
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

// Raised upload timeout for the single bulk POST only (spec §4). The
// standard 30s timeout (api/client.ts SYNC_FETCH_TIMEOUT_MS) would always
// fire before a ~100MB op gets a response. Exact cap pending one
// real-profile measurement.
export const BULK_UPLOAD_TIMEOUT_MS = 300_000;

// Peers expand newest-K only (spec §1): REMOTE_OBJECT_CAPS keeps 2000
// historyVisit rows per device (background/index.ts). Expanding 1M rows
// then pruning is pure write amplification.
export const BULK_PEER_MAX_VISITS = 2000;

// Collection no longer builds one unbounded op for the whole import
// (observed on a real profile: tens of millions of visits, almost certainly
// inflated by a frequently-reloaded URL such as a local dev server — holding
// every encrypted segment for the entire scan resident in memory heads
// straight for an OOM of the MV3 service worker long before collection ever
// finishes). Instead, segments are grouped into chunks, and each chunk is
// flushed to its own `bulkImport` op — and handed to the caller to upload —
// as soon as it reaches this target, so peak memory is bounded to roughly
// one chunk's worth of segments rather than the whole import. Well under the
// server's MAX_BULK_HISTORY_PAYLOAD_BYTES (96MB, server/src/sync/routes.rs)
// so a chunk is never anywhere near the server's own per-op cap.
//
// Measured against post-compression ciphertext (spec §D), so the same 20MB
// target now holds far more visits per chunk than it used to (real-world
// compression ratio unverified — spec §7 — so the exact multiple isn't
// pinned down, unlike the ~38x synthetic-data figure in the spec). Left
// alone that would silently change what this constant was never meant to
// control on its own: visitCount per op (how much a single server row / a
// single retry represents), how much unflushed encrypted data a mid-import
// service-worker kill can lose progress on before the next page-level
// resume checkpoint, and how far collection can run ahead of the first
// network round trip. BULK_CHUNK_TARGET_VISITS below is a second ceiling
// for exactly that reason — flush on whichever limit is hit first, rather
// than deriving a new byte threshold from an unmeasured ratio.
const BULK_CHUNK_TARGET_BYTES = 20 * 1024 * 1024;

// Preserves roughly the pre-§D chunk cadence (the old ungrouped,
// uncompressed format hit ~80k visits per 20MB chunk at realistic revisit
// density) regardless of how well any given profile happens to compress —
// see BULK_CHUNK_TARGET_BYTES's comment above for why a byte-only ceiling
// stopped being enough on its own once ciphertext bytes no longer track
// visit count consistently.
export let BULK_CHUNK_TARGET_VISITS = 100_000;

/** Test-only: overrides BULK_CHUNK_TARGET_VISITS so a fixture can exercise
 * multi-chunk behavior (including resume across chunks) without a real
 * hundred-thousand-visit fixture. Same pattern as
 * setBulkChunkUploadDelayMsForTesting. */
export function setBulkChunkTargetVisitsForTesting(n: number): void {
  BULK_CHUNK_TARGET_VISITS = n;
}

// Defense in depth only: BULK_CHUNK_TARGET_BYTES above is checked *between*
// segments, so one single oversized segment (e.g. pathologically long
// titles) could in principle push a chunk past the server's cap before the
// target check ever fires. Segments are naturally tiny relative to this
// (BULK_SEGMENT_VISITS visits at realistic sizes is low single-digit MB), so
// this should never trip in practice — it exists only so that case fails
// loudly instead of the server silently rejecting a chunk we thought was
// safe to send.
const BULK_HARD_ABORT_BYTES = 90 * 1024 * 1024;

export const HISTORY_IMPORT_TOO_LARGE_MESSAGE =
  "HelixSync history import too large: narrow the history retention window and retry";

// Real wall-clock pause between chunk uploads (not yieldToEventLoop, which
// only hands control back to the event loop without actually waiting — see
// util/yield.ts's doc comment). A profile with hundreds of chunks otherwise
// runs encrypt+upload back-to-back with no gap at all, keeping the CPU
// pinned for the entire import. This trades wall-clock time (hundreds of
// chunks x this delay adds up) for a lower duty cycle. Mutable (not const)
// so tests can zero it out — same pattern as setHistoryCaptureEnabled etc. —
// rather than paying this delay in real wall-clock time per test.
let bulkChunkUploadDelayMs = 750;

export function setBulkChunkUploadDelayMsForTesting(ms: number): void {
  bulkChunkUploadDelayMs = ms;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Same paged search as the legacy backfill (history/index.ts): a single
// call for tens of thousands of items pulls that entire array across the
// Chromium IPC boundary in one shot. Kept in sync with that file by hand.
export let BULK_SEARCH_PAGE_SIZE = 5_000;

/** Test-only: overrides BULK_SEARCH_PAGE_SIZE so a fixture can exercise
 * many-page enumeration (including the paging-cursor logic) with a small
 * number of fixture URLs. Same pattern as setBulkChunkUploadDelayMsForTesting. */
export function setBulkSearchPageSizeForTesting(n: number): void {
  BULK_SEARCH_PAGE_SIZE = n;
}

// Same enumeration concurrency as the legacy backfill: `getVisits` is one
// IPC round trip per URL — bounded overlap, not a flood.
const BULK_URL_CONCURRENCY = 10;
const BULK_RESOLVE_SUBBATCH = 5;

// Same backfill-only transition filter as history/index.ts: auto_subframe
// visits are never user-intended top-level browsing. Scoped to import only
// (live onVisited has no transition).
const NON_USER_VISIT_TRANSITIONS: ReadonlySet<string> = new Set(["auto_subframe"]);

/** Deterministic bulk IDs (spec §2): UUIDv5(namespace=HISTORY_BULK,
 * deviceId + "bulkImport" + cutoffMs + chunkIndex) — the §8.3
 * deterministic-objectId idea applied one level up. A fresh random ID would
 * ship a second op on relogin (or on a post-SW-kill retry) that dedup never
 * catches; deterministic derivation makes a retry re-mint the same ID per
 * chunk → server duplicate, zero new bytes. Cutoff sensitivity is
 * intentional: a genuinely different scope is a genuinely different import.
 * `chunkIndex` distinguishes the (potentially many) chunks one import now
 * splits into (see BULK_CHUNK_TARGET_BYTES) — same scope + same chunk index
 * always re-derives the same IDs, so re-enumerating from scratch after a
 * mid-collect kill re-uploads already-done chunks as cheap duplicates
 * instead of new rows. */
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

// One URL's visits, pre-encryption plaintext for a v2 segment (spec §C):
// enumeration already resolves getVisits() once per URL (urlTimes below
// ensures each URL is visited exactly once in a run), so its visits are
// already grouped in hand here — flattening them to one BulkVisit per visit
// like v1 did would throw that grouping away and repeat `url`/`title` once
// per visit on the wire for no reason. `times` is epoch ms, not ISO strings
// (dropping BULK_SEGMENT_VISITS-scale `new Date().toISOString()` calls —
// see pushGroup below); a group may hold only part of a URL's visits when
// that URL's visit count straddles a segment boundary (see pushGroup).
interface CollectedGroup {
  url: string;
  title?: string;
  times: number[];
}

/** Largest value in `sorted` (ascending) strictly less than `bound`, or
 * `undefined` if none exists. Binary search since a hot URL's kept-times
 * array can be large. */
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

/** Enumerates history visits in the fixed window `[cutoffMs, endMs)` (fix A),
 * streaming them into segments of BULK_SEGMENT_VISITS. Same paged search +
 * getVisits enumeration as the legacy backfill, but no per-visit SHA-256 (no
 * per-visit objectIds; dedup moves up to the op level via operationId) and
 * no per-visit encrypt — one envelope per segment with the hoisted SDEK.
 * Returns aborted:true when the device disconnects mid-collect.
 *
 * Paging cursor (fix B): `chrome.history.search`'s per-URL `lastVisitTime`
 * in its result is the URL's *overall* last visit, not the visit that
 * matched this page's `[startTime, endTime)` window — using it directly as
 * the next page's `endTime` is what let a stall-detection escalation (the
 * old `fullyDuplicatePage` path, now deleted) skip URLs. Instead,
 * `urlTimes` holds every enumerated URL's kept, sorted, in-window times
 * (~8 bytes/visit — for a 1.1M-visit profile, about 9MB, an acceptable
 * trade for exact paging), and the next cursor is the largest time in the
 * *last* item's own kept-times array that is still `< queryEndTime`: every
 * URL with a visible visit newer than that is already on this page (so
 * nothing is skipped), and the chosen value is strictly below the current
 * cursor (so progress is guaranteed) — see fix.md §2 for the full
 * Chromium-semantics argument this relies on. `urlTimes.has(url)` is this
 * function's "seen" check, replacing the old `seenUrls` Set.
 *
 * Determinism (required by collectHistoryBulk's skip-by-count resume, fix
 * C): a fixed window plus this cursor rule makes re-enumeration from
 * scratch produce the identical visit stream, in the identical order, every
 * time — verified against a real 1.1M-visit history DB (fix.md). */
async function enumerateVisits(
  cutoffMs: number,
  endMs: number,
  skipState: { remaining: number },
  onSegment: (groups: CollectedGroup[]) => Promise<void>,
): Promise<{ total: number; aborted: boolean }> {
  let total = 0;
  let pending: CollectedGroup[] = [];
  // Tracked separately from `pending.length` (group count): the segment cap
  // is on *visits*, and one group can hold many — or, after a split, just a
  // few — visits.
  let pendingVisitCount = 0;

  async function flushSegment(): Promise<void> {
    if (pendingVisitCount === 0) return;
    const segment = pending;
    pending = [];
    total += pendingVisitCount;
    pendingVisitCount = 0;
    await onSegment(segment);
  }

  // Appends one URL's visit times to the segment(s) currently being built,
  // splitting across a segment boundary rather than letting a single hot
  // URL push a segment past BULK_SEGMENT_VISITS (spec §C) — a group is
  // allowed to appear in two (or, for a pathologically hot URL, more)
  // consecutive segments, each carrying a subset of its times.
  //
  // Skip-by-count resume (fix C): visits already covered by chunks a prior
  // run durably uploaded are dropped here, before they ever reach `pending`
  // — never serialized, compressed, or encrypted. `times` arrives in the
  // same deterministic stream order every run, so dropping the first
  // `skipState.remaining` of them lands on exactly the same boundary a
  // previous run's uploaded chunks stopped at.
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

  // Fix A: the first page's query is bounded above by `endMs`, not
  // unbounded — this is also the starting point `urlTimes`-derived cursors
  // below always progress downward from.
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
    // Pace measures only this call's own IPC wait, right after it — not the
    // whole page's nested work (encryption, uploads, their own pacing
    // sleeps), which is what let the old page-level pace compound into a
    // multi-minute sleep that could starve the MV3 service worker of any
    // activity long enough to be idle-killed (fix D).
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
      // Reserved synchronously, before the async getVisits() calls below, so
      // this URL can never be picked up twice even if it resurfaces in the
      // very next slice. Filled in with the real sorted times once resolved.
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
              // Fix A: no `?? Date.now()` fallback — a visit with no
              // recorded `visitTime` is skipped, never stamped "now".
              if (visit.visitTime === undefined) continue;
              const visitTime = visit.visitTime;
              if (visitTime < cutoffMs || visitTime >= endMs) continue;
              if (NON_USER_VISIT_TRANSITIONS.has(visit.transition ?? "")) continue;
              times.push(visitTime);
            }
            // Ascending, for determinism (fix A) and so `largestBelow` above
            // can binary-search it.
            times.sort((a, b) => a - b);
            return { url: item.url!, title: item.title, times };
          }),
        );
        // Pace this sub-batch's own IPC wait, right after it (fix D) — same
        // rationale as the search pace above.
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

/** Local widening of LocalOperation for this file's chunk hand-off only:
 * carries the ciphertext byte total flushChunk already tracked, so
 * uploadHistoryBulk can log an accurate payload size without re-serializing
 * the payload (see uploadHistoryBulk). Not added to the shared LocalOperation
 * type in sync/types.ts since no other call site needs it. */
interface BulkChunkOperation extends LocalOperation {
  chunkBytes: number;
}

// Old resume fields (before fix C's skip-by-count replaced page-granularity
// resume), kept only as a loose shape for detecting a device record written
// by a pre-fix build — see collectHistoryBulk's legacy-migration handling.
// Not part of DeviceRecord any more, so read via this cast rather than the
// real type.
interface LegacyResumeFields {
  historyBulkResumePageEndTime?: number;
  historyBulkResumePreviousPageEndTime?: number;
  historyBulkResumeChunkIndex?: number;
}

/** Collects history into one or more historyVisit/bulkImport chunk ops with
 * deterministic IDs, handing each chunk to `onChunk` as soon as it reaches
 * BULK_CHUNK_TARGET_BYTES rather than accumulating the whole import in
 * memory (see that constant's doc comment — this is what keeps a
 * many-million-visit profile from OOMing the service worker). `onChunk` is
 * awaited before collection continues, so at most one chunk's segments are
 * ever resident at once; a real upload inside `onChunk` also bounds how far
 * collection can run ahead of what's actually landed on the server.
 * `aborted: true` means the device disconnected mid-collect — any
 * already-flushed chunks stay uploaded (correct: they're independently
 * idempotent), but the partial chunk in progress is discarded, not flushed,
 * matching the old single-op behavior of never uploading incomplete data. */
export async function collectHistoryBulk(
  cutoffMs: number,
  endMs: number,
  onChunk: (operation: BulkChunkOperation) => Promise<void>,
): Promise<BulkCollectResult> {
  const device = await getDevice();
  if (!device) return { chunkCount: 0, totalVisitCount: 0, aborted: false };

  // Reuse the persisted cutoff/end when retrying a mid-POST kill (see
  // backfillHistoryBulk): same scope → same deterministic IDs per chunk
  // index → server duplicate instead of new rows for chunks already sent.
  const effectiveCutoff =
    device.historyBulkCutoffMs !== undefined ? device.historyBulkCutoffMs : cutoffMs;
  let effectiveEndMs = device.historyBulkEndMs !== undefined ? device.historyBulkEndMs : endMs;

  // Legacy in-progress migration (fix C): a device record written by a
  // pre-fix build either still carries the old page-granularity resume
  // fields, or has a cutoff persisted but no `historyBulkEndMs` (that field
  // didn't exist yet). Either signals "this is the owner's device right
  // now" — treated as "uploaded 0 chunks": `historyBulkEndMs` is backfilled
  // to now and the old fields are dropped. Chunks 0..k re-derive the same
  // deterministic IDs and land as server duplicates (fix.md §3's permanent
  // bulk dedup) — content differs slightly from what's already stored, but
  // each full chunk is still exactly BULK_CHUNK_TARGET_VISITS visits, so
  // totals stay consistent; chunks after that upload as genuinely new. Not
  // a general migration — just this one specific transition, since a
  // cleverer one isn't needed for a single in-flight import.
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

  const sdek = await getSdek(device.encryptionRootKey, device.encryptionRootKeyVersion);
  const keyVersion = device.encryptionRootKeyVersion;
  // Decided once per import (feature-detect is stable — see
  // supportsDeflateRaw's doc comment) so every segment in every chunk this
  // run produces agrees on whether its plaintext bytes were compressed.
  const codec: "deflate-raw" | undefined = supportsDeflateRaw() ? "deflate-raw" : undefined;

  let chunkSegments: EncryptionEnvelope[] = [];
  let chunkVisitCount = 0;
  let chunkBytes = 0;
  // Change 3 (docs/protocol.md §8.3.2): per-hour visit-COUNT histogram for
  // the chunk currently being built, accumulated as each segment is placed
  // into it (see the `onSegment` callback below) — built from exactly the
  // visit times that make it into `pending`/`chunkSegments`, which is why it
  // lives here rather than being derived from `chunkVisitCount` after the
  // fact: `pushGroup`'s skip-by-count resume (fix C) drops already-uploaded
  // visits *before* they ever reach a segment, so a histogram built from raw
  // enumeration would double-count them on a resumed run.
  let chunkVisitHours = new Map<string, number>();
  let chunkIndex = uploadedChunks;
  let totalVisitCount = 0;
  let chunksFlushedThisRun = 0;

  // MV3 keep-alive (fix D): a `setTimeout` sleep, however it's paced, does
  // not itself count as worker activity for the ~30s service-worker idle
  // timer. A real profile's import can run for many minutes; without
  // something else touching an extension API on a short, steady cadence,
  // Chrome can kill the worker mid-import regardless of how well-paced the
  // work itself is. `getPlatformInfo` is a trivial, side-effect-free call
  // used only for this. Cleared in `finally` so it never outlives this call
  // (including on throw/abort).
  const keepAliveIntervalId = setInterval(() => {
    chrome.runtime.getPlatformInfo(() => {
      void chrome.runtime.lastError; // acknowledge to avoid an "unchecked" warning
    });
  }, 20_000);

  const flushChunk = async (): Promise<void> => {
    if (chunkVisitCount === 0) return;
    // Drain anything already locally queued (live bookmark/history/tab
    // capture) before claiming this chunk's sequence number. This op
    // uploads directly via uploadHistoryBulk below (onChunk), bypassing the
    // pending_operations queue that engine.ts's uploadPending normally
    // serializes all uploads through. Without draining first, an
    // already-queued op with a *lower*, earlier-reserved device sequence
    // can still be sitting unsent when this chunk — a *higher* number,
    // reserved later — uploads directly and gets accepted first, advancing
    // the server's last-accepted sequence past that still-queued op. The
    // server then rejects it outright as sequence_conflict the next time
    // engine.ts tries to upload it, which classifyRejections (sync/engine.ts)
    // treats as unrecoverable and drops permanently — observed on a real
    // profile as a burst of dropped live-capture operations during an
    // in-progress bulk import. Draining first guarantees nothing with a
    // lower reserved number is still outstanding when this chunk's number
    // is claimed, so upload order can never invert relative to reservation
    // order. (A live-capture op reserved in the narrow window between this
    // drain finishing and reserveSequenceBatch below is still possible in
    // principle, but that's a single microtask hop, not this chunk's full
    // encrypt+upload duration — which is what actually produced the failure
    // observed in the field.)
    for (let more = true; more; ) {
      more = await uploadPending();
    }
    const { operationId, objectId } = await deterministicBulkIds(device.deviceId, effectiveCutoff, chunkIndex);
    // One device-sequence number per chunk (protocol.md §4.1) — each chunk
    // is its own op now, not one shared op for the whole import.
    const { startDeviceSequence, startLamport } = await reserveSequenceBatch(1);
    const container: BulkHistoryContainer = {
      v: 1,
      bulkVersion: 2,
      codec,
      visitCount: chunkVisitCount,
      segments: chunkSegments,
    };
    // Change 3 (docs/protocol.md §8.3.2): by construction — every time is
    // added to `chunkVisitHours` exactly once, in `onSegment` below, for
    // exactly the times that ended up in `chunkSegments` — this must sum to
    // `chunkVisitCount`. Asserted here rather than trusted, since a mismatch
    // would mean the server's `visit_hours_mismatch` validation silently
    // rejects every future import until this is fixed; better to fail loud
    // and immediately on the client that produced the bad histogram.
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
    // Awaited before collection resumes: bounds how far ahead of the
    // server collection can run, and lets this chunk's segments (now
    // replaced by the fresh arrays above) be garbage-collected once
    // `operation` itself goes out of scope after the caller is done with it.
    await onChunk(operation);
    // Checkpoint persisted only *after* the upload above has returned (i.e.
    // accepted or server-side duplicate) — never before. If the worker dies
    // between the upload and this write, the next run re-sends this one
    // chunk, which the server's permanent bulk dedup (fix.md §3) turns into
    // a cheap duplicate rather than a lost or double-counted chunk.
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
    // Real pause, not a yield — see bulkChunkUploadDelayMs's doc comment.
    await sleep(bulkChunkUploadDelayMs);
  };

  let total = 0;
  let aborted = false;
  try {
    const skipState = { remaining: uploadedVisits };
    ({ total, aborted } = await enumerateVisits(
      effectiveCutoff,
      effectiveEndMs,
      skipState,
      async (groups) => {
        // One envelope per segment (own nonce, own tag) under the same SDEK.
        // Pure-TS AEAD (extension/src/crypto/index.ts) is the single biggest
        // CPU cost in this whole pass — paced on its own measured duration so
        // it alone can't push the duty cycle past the target. The
        // compression step (spec §D) runs on plaintext bytes between
        // serialization and encryption, so it's measured inside the same
        // span as the encrypt call below rather than left unpaced.
        const plaintext: BulkSegmentPlaintextV2 = {
          v: 2,
          groups: groups.map((g) => ({ u: g.url, t: g.title, v: g.times })),
        };
        let visitCount = 0;
        for (const g of groups) visitCount += g.times.length;
        // Change 3 (docs/protocol.md §8.3.2): accumulate this chunk's
        // per-hour histogram from exactly these `groups` — the same times
        // about to be serialized into this segment, after `pushGroup`'s
        // skip-by-count resume (fix C) has already dropped anything covered
        // by a prior run's uploaded chunks. Counting here, rather than from
        // the raw enumeration, is what keeps a resumed run's histogram
        // correct.
        for (const g of groups) {
          for (const t of g.times) {
            const key = hourKey(t);
            chunkVisitHours.set(key, (chunkVisitHours.get(key) ?? 0) + 1);
          }
        }
        const jsonBytes = textEncoder.encode(JSON.stringify(plaintext));
        const encryptStartedAt = Date.now();
        const plaintextBytes = codec === "deflate-raw" ? await deflateRaw(jsonBytes) : jsonBytes;
        const envelope = encryptBytesWithSdek(plaintextBytes, sdek, keyVersion);
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
    void total;

    // Discard rather than flush a partial chunk on abort — matches the old
    // single-op contract of never uploading an incomplete collection pass.
    if (!aborted) {
      await flushChunk();
      // Import fully complete: clear the resume checkpoint. Cutoff and end
      // are kept (unlike the checkpoint) — they document the import's
      // scope, and the existing code already keeps the cutoff for the same
      // reason.
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

/** Uploads one bulk op as a single-op batch with the raised bulk timeout.
 * accepted/duplicate → success (caller stamps initialImportCompletedAt via
 * the normal background path). payload_too_large → throws a
 * narrow-retention error (stays single-op by design, never splits). */
export async function uploadHistoryBulk(operation: BulkChunkOperation): Promise<void> {
  // Persist IDs before POST so a mid-POST SW kill retries with the same
  // operationId (spec §2). Correctness no longer depends on this surviving
  // (deterministic re-mint covers relogin), but it makes the common retry
  // path idempotent even when the cutoff would otherwise shift by seconds.
  const device = await getDevice();
  if (!device) return;
  await putDevice({
    ...device,
    historyBulkCutoffMs: device.historyBulkCutoffMs,
    historyBulkOperationId: operation.operationId,
    historyBulkObjectId: operation.objectId,
  });

  // Sum of segment ciphertext lengths, tracked by flushChunk as it built
  // this chunk — an exact-enough stand-in for the real payload size (this
  // log line's only use) without re-JSON.stringify-ing operation.payload,
  // which api/client.ts's uploadOperations already serializes once for the
  // actual POST body. A full chunk is O(20MB); doing that twice per chunk
  // was roughly the cost of the entire AEAD pass, spent and thrown away.
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

/** One-time bulk import: collects with `cutoffMs` scoping and uploads each
 * chunk (see collectHistoryBulk) as it's ready, rather than building the
 * whole import in memory first. Aborts cleanly (returns, no throw) when the
 * device disconnects mid-collect or there is nothing in scope — the next
 * login retries. */
export async function backfillHistoryBulk(cutoffMs: number): Promise<void> {
  console.log("HelixSync: backfillHistoryBulk called", { cutoffMs });
  const device = await getDevice();
  if (!device) {
    console.log("HelixSync: backfillHistoryBulk skipped (no device)");
    return;
  }
  // Persist the cutoff and end (fix A: fixed import window) before
  // collecting so a mid-POST retry reuses the same scope (same
  // deterministic IDs per chunk). A mid-collect kill leaves the previous
  // values in place and restarts enumeration from scratch on retry —
  // already-uploaded chunks re-derive their same IDs and land as cheap
  // server duplicates; correct, wasteful. Both persisted together, in the
  // same `putDevice`, the first time — later retries reuse both, never
  // recomputing either on its own.
  //
  // Change 2: `historyBulkEndMs`'s primary source is now
  // background/index.ts's `initializeCaptureForSettings`, which persists it
  // *before* live capture ever registers, so by the time this function runs
  // `device.historyBulkEndMs` is normally already set and this `Date.now()`
  // is never actually used. It's kept here only as a fallback for a device
  // record that somehow still lacks it (see storage/db.ts's doc comment on
  // the field) — this function must never let the import proceed with no
  // end bound at all.
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

// --- Peer expansion (spec §4) -------------------------------------------

/** Type guard for a bulk container payload (outer, plaintext count +
 * encrypted segments). Old clients don't know bulkImport: per protocol.md
 * §13 they store-but-don't-apply it. Accepts both wire versions (spec §C) —
 * v1 data is never rewritten to v2, so both must keep decoding forever. */
export function isBulkContainer(payload: unknown): payload is BulkHistoryContainer {
  if (typeof payload !== "object" || payload === null) return false;
  const p = payload as Record<string, unknown>;
  return (
    (p["bulkVersion"] === 1 || p["bulkVersion"] === 2) &&
    typeof p["visitCount"] === "number" &&
    Array.isArray(p["segments"])
  );
}

// Normalized per-visit shape produced by decoding either plaintext version:
// `t` is epoch ms (not an ISO string) so expandBulkNewestK's sort below is a
// numeric comparison — cheaper and simpler than the old ISO string
// comparator (spec §C) — and so pruned entries (all but the surviving K)
// never pay a toISOString call at all.
interface DecryptedEntry {
  url: string;
  title?: string;
  t: number;
}

interface DecryptedSegment {
  entries: DecryptedEntry[];
}

/** Decodes one already-decrypted (or, in tests, never-encrypted) segment
 * plaintext into the normalized entry shape, branching on its `v` field:
 * `{v:2, groups}` expands each group's epoch-ms times back to one entry per
 * visit; `{v:1, visits}` (or the field-less `{visits}` shape some
 * testing-only fixtures use) converts each visit's ISO `visitedAt` to epoch
 * ms once, here, rather than carrying strings through the sort below. */
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

/** Decrypts one segment envelope with the hoisted SDEK path, inflating
 * first when the container says its plaintext bytes were compressed (spec
 * §D: `codec` is a container-level field — every segment in one container
 * shares the same producer decision). Returns null for undecryptable (or,
 * with a corrupted compressed payload, un-inflatable) segments — same skip
 * contract as engine decryptors, so a single bad segment fails closed
 * instead of throwing out of the whole expansion. */
async function decryptSegment(
  segment: unknown,
  rekB64: string,
  codec: "deflate-raw" | undefined,
): Promise<DecryptedSegment | null> {
  try {
    if (typeof segment !== "object" || segment === null) return null;
    const s = segment as Record<string, unknown>;
    // Testing-only plaintext segments (encryptionVersion 0): { v, visits }
    // or { v, groups }. Never compressed — codec only applies to encrypted
    // segments.
    if (s["ciphertext"] === undefined) {
      return decodeSegmentPlaintext(s);
    }
    const envelope = segment as EncryptionEnvelope;
    const sdek = await getSdek(rekB64, envelope.keyVersion);
    const decryptedBytes = decryptBytesWithSdek(envelope, sdek);
    const plaintextBytes = codec === "deflate-raw" ? await inflateRaw(decryptedBytes) : decryptedBytes;
    const plaintext = JSON.parse(textDecoder.decode(plaintextBytes)) as Record<string, unknown>;
    return decodeSegmentPlaintext(plaintext);
  } catch {
    return null;
  }
}

/** Expands a bulk container to the newest-K visits, memory-bounded (spec
 * §1): segments aren't globally sorted, so every segment must be decrypted,
 * but only the newest K survive. Accumulates with periodic prune so a 1M
 * profile never holds 1M visits at once — peak is a small multiple of K,
 * not N. Returns visits sorted newest-first. */
export async function expandBulkNewestK(
  container: BulkHistoryContainer,
  rekB64: string,
  maxVisits: number,
  isAborted: () => Promise<boolean>,
): Promise<BulkVisit[]> {
  // Prune threshold: keep memory bounded to a small multiple of K. 4x is
  // enough to amortize sort cost without ever approaching N.
  const PRUNE_MULTIPLE = 4;
  // v1 containers never carry `codec` at all (spec §C: BulkHistoryContainerV1
  // has no such field); v2 containers without it are uncompressed, same as
  // an explicit `codec: undefined` — decryptSegment treats both identically.
  const codec = "codec" in container ? container.codec : undefined;
  let acc: DecryptedEntry[] = [];
  for (const segment of container.segments) {
    if (await isAborted()) return [];
    // Same pure-TS AEAD cost as the collect side (see collectHistoryBulk's
    // onSegment), paced the same way — a peer applying a large bulk import
    // decrypts every segment on this same background thread.
    const decryptStartedAt = Date.now();
    const decrypted = await decryptSegment(segment, rekB64, codec);
    await paceForWork(Date.now() - decryptStartedAt);
    if (!decrypted) continue;
    for (const e of decrypted.entries) acc.push(e);
    if (acc.length >= maxVisits * PRUNE_MULTIPLE) {
      acc.sort((a, b) => b.t - a.t);
      acc.length = Math.min(acc.length, maxVisits);
      await yieldToEventLoop();
    }
  }
  acc.sort((a, b) => b.t - a.t);
  // Convert only the surviving K to visitedAt ISO strings — the N-K entries
  // pruned above never pay a toISOString call (spec §C: K =
  // BULK_PEER_MAX_VISITS = 2000, N can be 1M).
  return acc.slice(0, maxVisits).map((e) => ({
    url: e.url,
    title: e.title,
    visitedAt: new Date(e.t).toISOString(),
  }));
}

/** Deterministic peer row IDs (spec §4): (bulkObjectId, index) — idempotent
 * re-apply overwrites the same rows. Index is the position in the
 * newest-first expansion, stable across re-applies of the same bulk op. */
export async function bulkPeerObjectId(bulkObjectId: string, index: number): Promise<string> {
  return deterministicUuid(bulkObjectId, String(index));
}
