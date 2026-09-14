// History synchronization per docs/protocol.md §8.3: visits are immutable,
// append-only events — no field merge or tombstones, unlike bookmarks.
// Retention/compaction of *sync* history is a server concern
// (docs/protocol.md §11); this module does not prune the browser's native
// history, which has its own independent retention already.
import { createLocalOperation, createLocalOperationsBatch, registerApplier } from "../sync/engine";
import type { PendingLocalOperation } from "../sync/engine";
import { getDevice, putRemoteObject } from "../storage/db";
import { createSuppressionGuard } from "../sync/suppress";
import { deterministicUuid } from "../util/uuid";
import type { HistoryVisitPayload, OperationOut } from "../sync/types";

// See sync/suppress.ts. Chrome's docs don't state whether `addUrl` (used
// by `applyRemote` below) fires `onVisited` — if it does, applying a
// remote visit would otherwise mint a *new* historyVisit object (its
// objectId embeds this device's id and the local re-derived visitedAt, so
// §8.3's dedup-by-objectId rule can't catch it) that the origin device
// then re-applies right back, forever. Guarding the addUrl call costs
// nothing if the event turns out not to fire.
const guard = createSuppressionGuard();

async function handleVisit(url: string, title: string | undefined, visitTime: number): Promise<void> {
  if (guard.isSuppressed()) return;
  const device = await getDevice();
  if (!device) return;

  const visitedAt = new Date(visitTime).toISOString();
  const objectId = await deterministicUuid("historyVisit", url, visitedAt, device.deviceId);

  const payload: HistoryVisitPayload = { url, title, visitedAt };

  await createLocalOperation("historyVisit", objectId, "visit", payload);
}

async function handleVisited(item: chrome.history.HistoryItem): Promise<void> {
  if (!item.url) return;
  await handleVisit(item.url, item.title, item.lastVisitTime ?? Date.now());
}

let captureRegistered = false;

export function registerCapture(): void {
  // See the matching guard in bookmarks/index.ts::registerCapture — called
  // on every startup and every REFRESH_CAPTURE_CONFIG message, so this must
  // stay idempotent or repeated settings saves register the listener
  // multiple times.
  if (captureRegistered) return;
  captureRegistered = true;

  chrome.history.onVisited.addListener((item) => {
    handleVisited(item).catch((e) => console.error("HelixSync history onVisited", e));
  });
}

// chrome.history.search() only returns the most recent visit per URL, so
// each matching URL is re-expanded via getVisits() to recover every
// individual past visit — matching the one-object-per-visit model
// onVisited already produces going forward (see file header).
const BACKFILL_MAX_RESULTS = 100_000;

// Visits are flushed via createLocalOperationsBatch in chunks of this size
// rather than one array covering the whole backfill (bounds memory and
// IndexedDB transaction size for accounts with tens of thousands of visits)
// and rather than one at a time (each `createLocalOperation` call opens
// three separate IndexedDB transactions purely for sequence/lamport/queue
// bookkeeping — pure overhead when, unlike live capture, nothing else needs
// to observe those values between one backfilled visit and the next).
const BACKFILL_FLUSH_CHUNK = 500;

// `chrome.history.getVisits` is one IPC round trip to the browser process
// per distinct URL, and `deterministicUuid` is one WebCrypto SHA-256 digest
// per visit — for an account with tens of thousands of URLs, running those
// fully sequentially (one `await` at a time) is the dominant cost of
// backfill, dwarfing the IndexedDB/network side that `BACKFILL_FLUSH_CHUNK`
// batches. This bounds how many URLs are resolved concurrently: high enough
// to overlap that IPC/hashing latency instead of serializing it, low enough
// not to flood the browser process with thousands of simultaneous
// `getVisits` calls at once.
const BACKFILL_URL_CONCURRENCY = 25;

async function resolveVisitOps(
  item: chrome.history.HistoryItem,
  deviceId: string,
): Promise<PendingLocalOperation[]> {
  if (!item.url) return [];
  const url = item.url;
  const visits = await chrome.history.getVisits({ url });
  return Promise.all(
    visits.map(async (visit): Promise<PendingLocalOperation> => {
      const visitedAt = new Date(visit.visitTime ?? Date.now()).toISOString();
      const objectId = await deterministicUuid("historyVisit", url, visitedAt, deviceId);
      const payload: HistoryVisitPayload = { url, title: item.title, visitedAt };
      return { objectType: "historyVisit", objectId, operationType: "visit", payload };
    }),
  );
}

/** One-time import of history that accumulated before HelixSync was
 * installed — chrome.history.onVisited only fires for visits going
 * forward, so the browser's existing history would otherwise never reach
 * the server. */
export async function backfillExisting(): Promise<void> {
  const device = await getDevice();
  if (!device) return;

  const items = await chrome.history.search({
    text: "",
    startTime: 0,
    maxResults: BACKFILL_MAX_RESULTS,
  });

  let pending: PendingLocalOperation[] = [];
  for (let i = 0; i < items.length; i += BACKFILL_URL_CONCURRENCY) {
    const slice = items.slice(i, i + BACKFILL_URL_CONCURRENCY);
    const opsPerUrl = await Promise.all(slice.map((item) => resolveVisitOps(item, device.deviceId)));

    for (const ops of opsPerUrl) {
      for (const op of ops) {
        pending.push(op);
        if (pending.length >= BACKFILL_FLUSH_CHUNK) {
          await createLocalOperationsBatch(pending);
          pending = [];
        }
      }
    }
  }
  if (pending.length > 0) await createLocalOperationsBatch(pending);
}

async function applyRemote(op: OperationOut, payload: unknown): Promise<void> {
  const p = payload as HistoryVisitPayload;
  // chrome.history.addUrl only supports adding a visit "now" for a URL,
  // with no way to set a historical timestamp or title — re-verified
  // against the current Chrome extensions API reference (September 2026):
  // "Adds a URL to the history at the current time with a transition type
  // of 'link'." `UrlDetails` accepts only `url`. There is no addPage-style
  // alternative and no deprecated API that does more (AI rule #4/#5: never
  // invent browser APIs). This is a hard Chromium platform limit, not an
  // oversight — so rather than silently losing the original visitedAt/
  // title, the incoming operation is also recorded in `remote_objects`
  // (`putRemoteObject` below), which the popup surfaces as "Synced history
  // from other devices" showing the real title/url/visitedAt even though
  // chrome://history itself can only ever show "visited just now", no
  // title.
  try {
    await guard.run(() => chrome.history.addUrl({ url: p.url }));
  } catch (e) {
    console.warn("HelixSync: failed to apply remote history visit", e);
  }

  const device = await getDevice();
  if (!device || op.deviceId === device.deviceId) return; // own visit, already native
  await putRemoteObject({
    objectId: op.objectId,
    objectType: "historyVisit",
    originDeviceId: op.deviceId,
    payload: p,
    deleted: false,
    updatedAt: op.createdAt,
  });
}

registerApplier("historyVisit", applyRemote);
