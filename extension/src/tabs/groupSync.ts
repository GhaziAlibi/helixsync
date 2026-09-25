// Pure decision logic behind tab group auto-materialization
// (docs/protocol.md §8.5), split out from src/tabs/index.ts so it can be
// unit tested without a `chrome.*` global — this project's vitest setup
// has no chrome API mock harness, and src/tabs/index.ts itself touches
// `chrome.tabGroups` at module load (feature detection), which throws
// under plain vitest/node.
import type { TabGroupPayload } from "../sync/types";

/** Maps a synced TabGroupPayload to `chrome.tabGroups.update`'s argument
 * shape, omitting fields the payload never set. */
export function tabGroupUpdateProps(payload: TabGroupPayload): chrome.tabGroups.UpdateProperties {
  const props: chrome.tabGroups.UpdateProperties = { collapsed: payload.collapsed };
  if (payload.title !== undefined) props.title = payload.title;
  if (payload.color !== undefined) props.color = payload.color as chrome.tabGroups.ColorEnum;
  return props;
}

/** Decides what to pass to `chrome.tabs.group`: join the already-mapped
 * local Chromium group if one exists for this `groupObjectId`, otherwise
 * create a new one. */
export function tabsGroupOptions(
  tabId: number,
  existingChromiumGroupId: string | undefined,
): chrome.tabs.GroupOptions {
  return existingChromiumGroupId !== undefined
    ? { tabIds: tabId, groupId: Number(existingChromiumGroupId) }
    : { tabIds: tabId };
}
