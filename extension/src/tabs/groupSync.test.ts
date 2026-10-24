import { describe, expect, it } from "vitest";
import { tabGroupUpdateProps, tabsGroupOptions } from "./groupSync";
import type { TabGroupPayload } from "../sync/types";

// These two functions are the pure decision logic behind tab group
// auto-materialization (docs/protocol.md §8.5): whether to join an
// already-mapped local Chromium group or create a new one, and how to
// translate a synced TabGroupPayload into chrome.tabGroups.update's
// argument shape. The actual chrome.tabs.group/chrome.tabGroups.update
// calls that consume these (syncTabGroup, applyGroupRemote in
// src/tabs/index.ts) require a real Chromium tabGroups API and are not
// exercised here — this project's vitest setup has no chrome API mock
// harness. Verify those manually per README.md's "Manual verification"
// notes: load the built extension in two Helium/Chromium profiles, group
// some tabs on one, and confirm the other materializes one local group
// with matching title/color/collapsed state once its member tabs restore.

describe("tabsGroupOptions (docs/protocol.md §8.5 group materialization)", () => {
  it("creates a new group when no local mapping exists yet", () => {
    expect(tabsGroupOptions(42, undefined)).toEqual({ tabIds: 42 });
  });

  it("joins the existing local Chromium group when one is already mapped", () => {
    expect(tabsGroupOptions(42, "7")).toEqual({ tabIds: 42, groupId: 7 });
  });
});

describe("tabGroupUpdateProps", () => {
  it("always includes collapsed", () => {
    const payload: TabGroupPayload = { collapsed: true };
    expect(tabGroupUpdateProps(payload)).toEqual({ collapsed: true });
  });

  it("includes title and color only when present", () => {
    const payload: TabGroupPayload = { collapsed: false, title: "Research", color: "blue" };
    expect(tabGroupUpdateProps(payload)).toEqual({
      collapsed: false,
      title: "Research",
      color: "blue",
    });
  });

  it("omits title/color when absent from the payload", () => {
    const payload: TabGroupPayload = { collapsed: false };
    const props = tabGroupUpdateProps(payload);
    expect(props).not.toHaveProperty("title");
    expect(props).not.toHaveProperty("color");
  });
});
