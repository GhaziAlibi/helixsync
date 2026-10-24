import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setCpuPaceTargetForTesting } from "../util/pace";
import { consumeReplayEcho, noteVisit, replayVisitsIntoBrowserHistory, resetReplayStateForTesting } from "./replay";
import type { NewestVisitByUrl } from "./replay";

setCpuPaceTargetForTesting(1);

// replay.ts in isolation: which URLs get written into the browser's history,
// in what order, and how the echo marks behave. How it is wired into the
// remote-apply path and the capture listener is covered in capture.test.ts.

const addUrlMock = vi.fn(async (_details: { url: string }) => {});
const getVisitsMock = vi.fn(async (_details: { url: string }) => [] as unknown[]);

(globalThis as unknown as { chrome: unknown }).chrome = {
  history: {
    addUrl: (details: { url: string }) => addUrlMock(details),
    getVisits: (details: { url: string }) => getVisitsMock(details),
  },
};

const keepGoing = async () => false;

function visit(url: string, time: number): [string, number] {
  return [url, time];
}

/** The way a caller builds the input: every visit seen, newest kept per URL. */
function run(visits: Array<[string, number]>, shouldStop: () => Promise<boolean> = keepGoing): Promise<number> {
  const newest: NewestVisitByUrl = new Map();
  for (const [url, time] of visits) noteVisit(newest, url, time);
  return replayVisitsIntoBrowserHistory(newest, shouldStop);
}

function addedUrls(): string[] {
  return addUrlMock.mock.calls.map(([details]) => details.url);
}

beforeEach(() => {
  addUrlMock.mockReset();
  addUrlMock.mockImplementation(async () => {});
  getVisitsMock.mockReset();
  getVisitsMock.mockImplementation(async () => []);
  resetReplayStateForTesting();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("replayVisitsIntoBrowserHistory", () => {
  it("adds each distinct URL once, oldest synced visit first", async () => {
    const added = await run(
      [
        visit("https://b.test/", 3000),
        visit("https://a.test/", 1000),
        visit("https://c.test/", 2000),
        // a second, older visit of a.test must not add it again or move it
        visit("https://a.test/", 500),
      ],
    );

    expect(added).toBe(3);
    expect(addedUrls()).toEqual(["https://a.test/", "https://c.test/", "https://b.test/"]);
  });

  it("orders a repeated URL by its newest visit", async () => {
    await run(
      [visit("https://a.test/", 100), visit("https://b.test/", 200), visit("https://a.test/", 300)],
    );

    expect(addedUrls()).toEqual(["https://b.test/", "https://a.test/"]);
  });

  it("treats a URL written with and without the root slash as one", async () => {
    await run(
      [visit("https://root.test", 100), visit("https://root.test/", 200)],
    );

    expect(addUrlMock).toHaveBeenCalledTimes(1);
  });

  it("skips a URL that already has a visit in the browser's history", async () => {
    getVisitsMock.mockImplementation(async ({ url }) => (url === "https://known.test/" ? [{ visitId: "1" }] : []));

    const added = await run(
      [visit("https://known.test/", 1000), visit("https://new.test/", 2000)],
    );

    expect(added).toBe(1);
    expect(addedUrls()).toEqual(["https://new.test/"]);
  });

  it("only ever writes http and https URLs", async () => {
    await run(
      [
        visit("javascript:alert(1)", 1),
        visit("chrome://settings/", 2),
        visit("file:///etc/passwd", 3),
        visit("data:text/html,hi", 4),
        visit("not a url", 5),
        visit("http://plain.test/", 6),
        visit("https://secure.test/", 7),
      ],
    );

    expect(addedUrls()).toEqual(["http://plain.test/", "https://secure.test/"]);
    expect(getVisitsMock).toHaveBeenCalledTimes(2);
  });

  it("sorts a visit with an unreadable time first rather than failing", async () => {
    await run(
      [visit("https://dated.test/", 5000), ["https://undated.test/", Number.NaN]],
    );

    expect(addedUrls()).toEqual(["https://undated.test/", "https://dated.test/"]);
  });

  it("leaves a URL alone when its history can't be checked", async () => {
    getVisitsMock.mockImplementation(async ({ url }) => {
      if (url === "https://broken.test/") throw new Error("ipc failed");
      return [];
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const added = await run(
      [visit("https://broken.test/", 1), visit("https://fine.test/", 2)],
    );

    expect(added).toBe(1);
    expect(addedUrls()).toEqual(["https://fine.test/"]);
    expect(consumeReplayEcho("https://broken.test/", Date.now())).toBe(false);
  });

  it("keeps going when addUrl fails for one URL, and counts only the successes", async () => {
    addUrlMock.mockImplementation(async ({ url }) => {
      if (url === "https://rejected.test/") throw new Error("Url is invalid");
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const added = await run(
      [visit("https://rejected.test/", 1), visit("https://ok.test/", 2)],
    );

    expect(added).toBe(1);
    expect(addUrlMock).toHaveBeenCalledTimes(2);
  });

  it("writes nothing once told to stop", async () => {
    const added = await run([visit("https://a.test/", 1)], async () => true);

    expect(added).toBe(0);
    expect(addUrlMock).not.toHaveBeenCalled();
  });

  it("stops part-way through a large replay when told to stop", async () => {
    const visits = Array.from({ length: 200 }, (_, i) => visit(`https://many.test/${i}`, i));
    let stop = false;
    addUrlMock.mockImplementation(async () => {
      stop = true;
    });

    const added = await run(visits, async () => stop);

    expect(added).toBeGreaterThan(0);
    expect(added).toBeLessThan(200);
  });

  it("does nothing for an empty list", async () => {
    expect(await run([], keepGoing)).toBe(0);
    expect(getVisitsMock).not.toHaveBeenCalled();
  });
});

describe("echo windows", () => {
  const T = Date.UTC(2026, 9, 1, 12, 0, 0);
  const clock = () => vi.spyOn(Date, "now");

  it("recognises the echo of a replayed URL by its visit time, exactly once", async () => {
    clock().mockReturnValue(T);
    await run([visit("https://echo.test/page", 1)]);

    expect(consumeReplayEcho("https://echo.test/page", T)).toBe(true);
    expect(consumeReplayEcho("https://echo.test/page", T)).toBe(false);
  });

  it("recognises an echo however late the browser delivers it", async () => {
    clock().mockReturnValue(T);
    await run([visit("https://late.test/", 1)]);

    // The event arrives ten minutes after the call; its visit time is still the call's.
    clock().mockReturnValue(T + 10 * 60_000);

    expect(consumeReplayEcho("https://late.test/", T)).toBe(true);
  });

  it("does not take a later visit by the user to the same URL for the echo", async () => {
    clock().mockReturnValue(T);
    await run([visit("https://again.test/", 1)]);

    expect(consumeReplayEcho("https://again.test/", T + 5_000)).toBe(false);
    // ...and that visit leaves the real echo still to be recognised.
    expect(consumeReplayEcho("https://again.test/", T)).toBe(true);
  });

  it("does not take an earlier visit for the echo either", async () => {
    clock().mockReturnValue(T);
    await run([visit("https://before.test/", 1)]);

    expect(consumeReplayEcho("https://before.test/", T - 5_000)).toBe(false);
  });

  it("matches the event's canonical form of the URL", async () => {
    clock().mockReturnValue(T);
    await run([visit("https://Example.COM", 1)]);

    expect(consumeReplayEcho("https://example.com/", T)).toBe(true);
  });

  it("never treats an event without a visit time as an echo", async () => {
    clock().mockReturnValue(T);
    await run([visit("https://untimed.test/", 1)]);

    expect(consumeReplayEcho("https://untimed.test/", undefined)).toBe(false);
  });

  it("does not mark a URL that was skipped", async () => {
    clock().mockReturnValue(T);
    getVisitsMock.mockImplementation(async () => [{ visitId: "1" }]);
    await run([visit("https://skipped.test/", 1)]);

    expect(consumeReplayEcho("https://skipped.test/", T)).toBe(false);
  });

  it("does not mark a URL it never replayed", async () => {
    clock().mockReturnValue(T);
    await run([visit("https://a.test/", 1)]);

    expect(consumeReplayEcho("https://other.test/", T)).toBe(false);
  });

  it("drops the window when addUrl fails, so a later real visit still counts", async () => {
    clock().mockReturnValue(T);
    addUrlMock.mockImplementation(async () => {
      throw new Error("nope");
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await run([visit("https://failed.test/", 1)]);

    expect(consumeReplayEcho("https://failed.test/", T)).toBe(false);
  });

  it("keeps a window for each replay of the same URL", async () => {
    clock().mockReturnValue(T);
    await run([visit("https://twice.test/", 1)]);
    clock().mockReturnValue(T + 1_000);
    await run([visit("https://twice.test/", 2)]);

    expect(consumeReplayEcho("https://twice.test/", T)).toBe(true);
    expect(consumeReplayEcho("https://twice.test/", T + 1_000)).toBe(true);
    expect(consumeReplayEcho("https://twice.test/", T)).toBe(false);
  });

  it("forgets the window of an echo that never arrived, once it is long stale", async () => {
    clock().mockReturnValue(T);
    await run([visit("https://never.test/", 1)]);

    // A replay much later sweeps what the browser never reported.
    clock().mockReturnValue(T + 31 * 60_000);
    await run([visit("https://another.test/", 1)]);

    expect(consumeReplayEcho("https://never.test/", T)).toBe(false);
  });
});
