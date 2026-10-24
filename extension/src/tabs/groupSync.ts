// Pure tab-group helpers, kept out of tabs/index.ts (which touches
// chrome.tabGroups at load) so they can be unit tested without chrome.
import type { TabGroupPayload } from "../sync/types";

/** `chrome.tabGroups.update` properties for a synced payload, omitting
 * fields the payload never set. */
export function tabGroupUpdateProps(payload: TabGroupPayload): chrome.tabGroups.UpdateProperties {
  const props: chrome.tabGroups.UpdateProperties = { collapsed: payload.collapsed };
  if (payload.title !== undefined) props.title = payload.title;
  if (payload.color !== undefined) props.color = payload.color as `${chrome.tabGroups.Color}`;
  return props;
}

/** Joins the already-mapped local group if there is one, else creates one. */
export function tabsGroupOptions(
  tabId: number,
  existingChromiumGroupId: string | undefined,
): chrome.tabs.GroupOptions {
  return existingChromiumGroupId !== undefined
    ? { tabIds: tabId, groupId: Number(existingChromiumGroupId) }
    : { tabIds: tabId };
}
