import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDLE_LOCK_MS, getAccountKey, isUnlocked, lockVault, onLock, setAccountKey, subscribeKeyring } from "./keyring";

let windowTarget: EventTarget;

beforeEach(() => {
  vi.useFakeTimers();
  windowTarget = new EventTarget();
  vi.stubGlobal("window", windowTarget);
});

afterEach(() => {
  lockVault();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("keyring", () => {
  it("holds the key until locked, then zeroes it", () => {
    const key = new Uint8Array(32).fill(7);
    setAccountKey(key);
    expect(isUnlocked()).toBe(true);
    expect(getAccountKey()).toBe(key);

    lockVault();
    expect(isUnlocked()).toBe(false);
    expect(getAccountKey()).toBeNull();
    expect([...key].every((b) => b === 0)).toBe(true);
  });

  it("zeroes the previous key when another is set", () => {
    const first = new Uint8Array(32).fill(1);
    setAccountKey(first);
    setAccountKey(new Uint8Array(32).fill(2));
    expect([...first].every((b) => b === 0)).toBe(true);
  });

  it("locks after the idle period without activity", () => {
    setAccountKey(new Uint8Array(32).fill(1));
    vi.advanceTimersByTime(IDLE_LOCK_MS - 20_000);
    expect(isUnlocked()).toBe(true);
    vi.advanceTimersByTime(40_000);
    expect(isUnlocked()).toBe(false);
  });

  it("activity pushes the idle lock back", () => {
    setAccountKey(new Uint8Array(32).fill(1));
    vi.advanceTimersByTime(IDLE_LOCK_MS - 30_000);
    windowTarget.dispatchEvent(new Event("pointerdown"));
    vi.advanceTimersByTime(IDLE_LOCK_MS - 30_000);
    expect(isUnlocked()).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(isUnlocked()).toBe(false);
  });

  it("runs lock listeners and tells subscribers about every change", () => {
    const onLocked = vi.fn();
    const onChange = vi.fn();
    const offLock = onLock(onLocked);
    const offChange = subscribeKeyring(onChange);

    setAccountKey(new Uint8Array(32));
    lockVault();
    expect(onLocked).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledTimes(2);

    offLock();
    offChange();
    setAccountKey(new Uint8Array(32));
    lockVault();
    expect(onLocked).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("stops watching for activity once locked", () => {
    const remove = vi.spyOn(windowTarget, "removeEventListener");
    setAccountKey(new Uint8Array(32));
    lockVault();
    expect(remove).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

// Every non-test source file in this folder, as text.
const sources = import.meta.glob(["./*.ts", "!./*.test.ts"], { query: "?raw", import: "default", eager: true }) as Record<
  string,
  string
>;

describe("no browser storage", () => {
  it("is not referenced by any vault source file", () => {
    const names = /localStorage|sessionStorage|indexedDB|IDBFactory|\bcaches\b|CacheStorage|serviceWorker|document\.cookie/;
    expect(Object.keys(sources)).toContain("./keyring.ts");
    for (const [file, text] of Object.entries(sources)) {
      const code = text
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n");
      expect(code, file).not.toMatch(names);
    }
  });
});
