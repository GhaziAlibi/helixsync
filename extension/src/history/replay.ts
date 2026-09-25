// Writes visits synced from other devices into this browser's own history, so
// they show up in chrome://history and in address-bar suggestions.
//
// chrome.history.addUrl is the only API for that, and it can only record a
// visit "now" with no title: a replayed visit carries the time it was synced,
// not the time it happened, and has no title until the page is next opened.
// Two guards keep the replay from feeding back into the sync:
//
//  1. A URL that already has any visit locally is skipped. It is already
//     discoverable, a re-applied snapshot doesn't pile up duplicate visits,
//     and a replay that did echo back could bounce between devices once
//     instead of forever.
//  2. addUrl's own chrome.history.onVisited event is not a visit by the user.
//     The browser stamps the visit at the moment of the call and the event
//     carries that time, so the capture listener recognises the echo by its
//     visit time falling inside the window of the call that caused it
//     (consumeReplayEcho), and the write is never uploaded as a new visit.
import { paceForWork } from "../util/pace";
import { isSyncableUrl } from "../util/url-scheme";
import { yieldToEventLoop } from "../util/yield";

/** Each synced URL's newest visit time (epoch ms). A replay needs nothing
 * else, so a large import is reduced to this as it is read. */
export type NewestVisitByUrl = Map<string, number>;

export function noteVisit(newest: NewestVisitByUrl, url: string, timeMs: number): void {
  const time = Number.isNaN(timeMs) ? 0 : timeMs;
  const previous = newest.get(url);
  if (previous === undefined || time > previous) newest.set(url, time);
}

// The browser stamps an addUrl visit at the moment of the call, and the event
// announcing it carries that time as `lastVisitTime`. So an echo is told apart
// by its visit time lying inside the window of the call that caused it, never
// by how soon it arrives: with tens of thousands of URLs the browser's events
// trail the calls by far more than any fixed timeout would allow (measured at
// up to 14 s for 20,000 URLs, and growing with the size of the replay).
const ECHO_SLACK_MS = 50;
// A window normally goes when its event arrives. This only bounds the memory
// of one whose event never does, say because the worker restarted first.
const ECHO_WINDOW_RETENTION_MS = 30 * 60_000;

// getVisits is one IPC round trip per URL; overlap a few at a time.
const EXISTS_CHECK_CONCURRENCY = 10;
const STOP_CHECK_INTERVAL = 50;

interface ReplayWindow {
  from: number;
  /** Infinity while the call is in flight: the event can beat the call's own return. */
  to: number;
  addedAt: number;
}

const replayWindows = new Map<string, ReplayWindow[]>();

export function resetReplayStateForTesting(): void {
  replayWindows.clear();
}

/** Chromium stores (and reports) URLs in canonical form, so windows and events
 * are matched in that form: "https://example.com" comes back as
 * "https://example.com/". */
function canonicalUrl(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

function expectEcho(url: string, callStartedAt: number): ReplayWindow {
  const key = canonicalUrl(url);
  const window: ReplayWindow = { from: callStartedAt - ECHO_SLACK_MS, to: Number.POSITIVE_INFINITY, addedAt: callStartedAt };
  const windows = replayWindows.get(key);
  if (windows) windows.push(window);
  else replayWindows.set(key, [window]);
  return window;
}

function forgetEcho(url: string, window: ReplayWindow): void {
  const key = canonicalUrl(url);
  const windows = replayWindows.get(key);
  if (!windows) return;
  const index = windows.indexOf(window);
  if (index >= 0) windows.splice(index, 1);
  if (windows.length === 0) replayWindows.delete(key);
}

/** True if a visit event for `url` at `visitTimeMs` is the echo of one of our
 * own replays, and consumes that window. The capture listener skips such
 * events. A later visit by the user to the same URL has a different time, so
 * it is never mistaken for one. */
export function consumeReplayEcho(url: string, visitTimeMs: number | undefined): boolean {
  if (visitTimeMs === undefined) return false;
  const key = canonicalUrl(url);
  const windows = replayWindows.get(key);
  if (!windows) return false;
  const index = windows.findIndex((w) => visitTimeMs >= w.from && visitTimeMs <= w.to);
  if (index < 0) return false;
  windows.splice(index, 1);
  if (windows.length === 0) replayWindows.delete(key);
  return true;
}

function sweepStaleWindows(now: number): void {
  for (const [key, windows] of replayWindows) {
    const live = windows.filter((w) => now - w.addedAt < ECHO_WINDOW_RETENTION_MS);
    if (live.length === 0) replayWindows.delete(key);
    else if (live.length !== windows.length) replayWindows.set(key, live);
  }
}

/** Adds each distinct URL that has no local visit yet to the browser's
 * history, oldest synced visit first. Returns how many were added. Stops
 * early (returning what was added so far) when `shouldStop` reports true.
 * A URL that can't be checked or added is skipped, never thrown. Paced like
 * the bulk import, since a large profile means many calls. */
export async function replayVisitsIntoBrowserHistory(
  newestByUrl: ReadonlyMap<string, number>,
  shouldStop: () => Promise<boolean>,
): Promise<number> {
  // One entry per URL, at its newest visit: a URL visited fifty times needs
  // one history entry, not fifty. Merged in canonical form, so "https://x.test"
  // and "https://x.test/" are one.
  const merged = new Map<string, { url: string; time: number }>();
  for (const [url, time] of newestByUrl) {
    if (!isSyncableUrl(url)) continue;
    const key = canonicalUrl(url);
    const previous = merged.get(key);
    if (!previous || time > previous.time) merged.set(key, { url, time });
  }
  // Oldest first: every addUrl is stamped "now", so call order is the only
  // way to keep the synced visits in order, newest ending up most recent.
  const ordered = [...merged.values()].sort((a, b) => a.time - b.time);

  const toAdd: string[] = [];
  for (let i = 0; i < ordered.length; i += EXISTS_CHECK_CONCURRENCY) {
    if (await shouldStop()) return 0;
    const startedAt = Date.now();
    const slice = ordered.slice(i, i + EXISTS_CHECK_CONCURRENCY);
    const alreadyKnown = await Promise.all(
      slice.map(async ({ url }) => {
        try {
          return (await chrome.history.getVisits({ url })).length > 0;
        } catch (e) {
          // Unknown state: leave the history alone rather than risk a duplicate.
          console.warn("HelixSync: history replay could not check a URL, skipping it", e);
          return true;
        }
      }),
    );
    slice.forEach(({ url }, index) => {
      if (!alreadyKnown[index]) toAdd.push(url);
    });
    await paceForWork(Date.now() - startedAt);
    await yieldToEventLoop();
  }

  sweepStaleWindows(Date.now());
  let added = 0;
  let blockStartedAt = Date.now();
  for (let i = 0; i < toAdd.length; i++) {
    if (i % STOP_CHECK_INTERVAL === 0) {
      if (await shouldStop()) break;
      blockStartedAt = Date.now();
    }
    const url = toAdd[i];
    const window = expectEcho(url, Date.now());
    try {
      await chrome.history.addUrl({ url });
      window.to = Date.now() + ECHO_SLACK_MS;
      added++;
    } catch (e) {
      forgetEcho(url, window);
      console.warn("HelixSync: history replay addUrl failed, skipping a URL", e);
    }
    if (i % STOP_CHECK_INTERVAL === STOP_CHECK_INTERVAL - 1) {
      await paceForWork(Date.now() - blockStartedAt);
      await yieldToEventLoop();
    }
  }
  return added;
}
