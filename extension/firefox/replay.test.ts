import { beforeEach, describe, expect, it, vi } from "vitest";

// The Firefox build's history replay, with firefox/platform.ts as @platform:
// a URL Firefox's history can't hold is skipped up front, so the replay
// neither calls addUrl for it (which throws there) nor logs a warning.
vi.mock("@platform", () => import("./platform"));

const addUrlMock = vi.fn(async (_details: { url: string }) => {});
(globalThis as unknown as { chrome: unknown }).chrome = {
  history: {
    addUrl: (details: { url: string }) => addUrlMock(details),
    getVisits: async () => [],
  },
};

const { noteVisit, replayVisitsIntoBrowserHistory } = await import("../src/history/replay");
const { setCpuPaceTargetForTesting } = await import("../src/util/pace");
setCpuPaceTargetForTesting(1);

beforeEach(() => addUrlMock.mockReset());

describe("history replay on Firefox", () => {
  it("skips URLs longer than Firefox's history accepts, without a warning", async () => {
    const warn = vi.spyOn(console, "warn");
    const long = "https://example.com/" + "a".repeat(2500);
    const newest = new Map();
    noteVisit(newest, "https://example.com/short", 1);
    noteVisit(newest, long, 2);

    const added = await replayVisitsIntoBrowserHistory(newest, async () => false);

    expect(added).toBe(1);
    expect(addUrlMock.mock.calls.map(([d]) => d.url)).toEqual(["https://example.com/short"]);
    expect(warn).not.toHaveBeenCalled();
  });
});
