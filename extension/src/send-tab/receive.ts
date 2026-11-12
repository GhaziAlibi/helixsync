// Receiving a tab another device sent (docs/protocol.md §12.5). Everything
// that arrives is untrusted until it decrypts under an AAD that names this
// device, and a server that replays or relabels a frame must get nothing
// opened.
import type { TabSendFrame } from "../api/websocket";
import { buildTabSendAad, decryptPayload } from "../crypto";
import { loadTranslator } from "../i18n";
import { getDevice } from "../storage/db";
import { isSyncableUrl } from "../util/url-scheme";
import { deviceName } from "./devices";
import { RECEIVE_LIMIT_PER_MINUTE, REPLAY_WINDOW_MS } from "./limits";
import type { TabSendPayload } from "./send";

export type ReceiveOutcome =
  | "opened"
  | "no_device"
  | "undecryptable"
  | "malformed"
  | "stale"
  | "replayed"
  | "bad_url"
  | "throttled";

const STATE_KEY = "tabSendState";
const MAX_ID_LENGTH = 64;
const NOTIFICATIONS_PERMISSION: chrome.permissions.Permissions = { permissions: ["notifications"] };

interface ReceiveState {
  /** id -> when it was received. Entries older than the replay window are
   * dropped: such a frame is rejected by its `sentAt` anyway. */
  seen: Record<string, number>;
  /** When tabs were last opened, for the per-minute cap. */
  opened: number[];
}

async function loadState(now: number): Promise<ReceiveState> {
  const stored = (await chrome.storage.session.get(STATE_KEY))[STATE_KEY] as Partial<ReceiveState> | undefined;
  const seen: Record<string, number> = {};
  for (const [id, at] of Object.entries(stored?.seen ?? {})) {
    if (typeof at === "number" && now - at <= REPLAY_WINDOW_MS) seen[id] = at;
  }
  const opened = (stored?.opened ?? []).filter((at) => typeof at === "number" && now - at < 60_000);
  return { seen, opened };
}

function parsePayload(value: unknown): TabSendPayload | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { url, title, sentAt } = value as Record<string, unknown>;
  if (typeof url !== "string" || typeof sentAt !== "number" || !Number.isFinite(sentAt)) return undefined;
  if (title !== undefined && typeof title !== "string") return undefined;
  return { url, sentAt, ...(title !== undefined ? { title } : {}) };
}

// One frame at a time, so two frames with the same id can't both pass the
// replay check before either is recorded.
let queue: Promise<unknown> = Promise.resolve();

/** Handles one frame. Never throws; the outcome says what happened. */
export function handleTabSend(frame: TabSendFrame): Promise<ReceiveOutcome> {
  const run = queue.then(() => process(frame));
  queue = run.catch(() => undefined);
  return run.catch((e): ReceiveOutcome => {
    console.warn("HelixSync: could not handle a sent tab", e);
    return "malformed";
  });
}

async function process(frame: TabSendFrame): Promise<ReceiveOutcome> {
  if (frame.id.length === 0 || frame.id.length > MAX_ID_LENGTH || frame.fromDeviceId.length > MAX_ID_LENGTH) {
    return "malformed";
  }
  const device = await getDevice();
  if (!device) return "no_device";

  let plaintext: unknown;
  try {
    plaintext = await decryptPayload(
      frame.envelope as Parameters<typeof decryptPayload>[0],
      device.accountKey,
      buildTabSendAad(frame.id, frame.fromDeviceId, device.deviceId),
    );
  } catch {
    // Wrong key, tampering, a frame meant for another device, or an envelope
    // version this build can't read. It's ephemeral: nothing to retry.
    return "undecryptable";
  }
  const payload = parsePayload(plaintext);
  if (!payload) return "malformed";

  const now = Date.now();
  if (now - payload.sentAt > REPLAY_WINDOW_MS) return "stale";

  const state = await loadState(now);
  if (Object.hasOwn(state.seen, frame.id)) return "replayed";
  // Recorded before the remaining checks, so a rejected frame can't be
  // replayed into success either.
  state.seen[frame.id] = now;

  let outcome: ReceiveOutcome;
  if (!isSyncableUrl(payload.url)) {
    outcome = "bad_url";
  } else if (state.opened.length >= RECEIVE_LIMIT_PER_MINUTE) {
    outcome = "throttled";
  } else {
    state.opened.push(now);
    outcome = "opened";
  }
  await chrome.storage.session.set({ [STATE_KEY]: state });
  if (outcome !== "opened") return outcome;

  // No windowId: the last focused window.
  await chrome.tabs.create({ url: payload.url, active: true });
  void notifyReceived(frame.fromDeviceId, payload).catch(() => {});
  return "opened";
}

/** Only with the optional `notifications` permission; without it the tab
 * simply opens. */
async function notifyReceived(fromDeviceId: string, payload: TabSendPayload): Promise<void> {
  if (!chrome.notifications || !(await chrome.permissions.contains(NOTIFICATIONS_PERMISSION))) return;
  const tr = await loadTranslator();
  const name = (await deviceName(fromDeviceId)) ?? tr.t("sendtab_unknownDevice");
  await chrome.notifications.create({
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title: tr.t("sendtab_notifReceived", { device: name }),
    message: payload.title || new URL(payload.url).host,
  });
}

export function resetReceiveQueueForTesting(): void {
  queue = Promise.resolve();
}
