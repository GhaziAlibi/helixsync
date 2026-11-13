import { ApiError, sendTabToServer, serverSupportsSendTab } from "../api/client";
import { buildTabSendAad, encryptPayload } from "../crypto";
import { getDevice } from "../storage/db";
import { isSyncableUrl } from "../util/url-scheme";
import { MAX_ENVELOPE_BYTES, MAX_TITLE_CHARS } from "./limits";

export type SendTabFailure =
  | "not_connected"
  | "unsupported"
  | "bad_url"
  | "too_large"
  | "offline"
  | "device_gone"
  | "rate_limited"
  | "failed";

export type SendTabResult = { ok: true } | { ok: false; reason: SendTabFailure; message?: string };

/** The plaintext inside a send-tab envelope. */
export interface TabSendPayload {
  url: string;
  title?: string;
  sentAt: number;
}

/** Encrypts `url` for `targetDeviceId` and asks the server to push it.
 * Nothing is retried or queued: an offline target is reported, not held. */
export async function sendTabToDevice(
  targetDeviceId: string,
  url: string,
  title?: string,
): Promise<SendTabResult> {
  const device = await getDevice();
  if (!device) return { ok: false, reason: "not_connected" };
  if (!isSyncableUrl(url)) return { ok: false, reason: "bad_url" };
  if (!(await serverSupportsSendTab())) return { ok: false, reason: "unsupported" };

  const payload: TabSendPayload = { url: new URL(url).href, sentAt: Date.now() };
  if (title) payload.title = title.slice(0, MAX_TITLE_CHARS);

  const id = crypto.randomUUID();
  const envelope = await encryptPayload(
    payload,
    device.accountKey,
    device.accountKeyVersion,
    buildTabSendAad(id, device.deviceId, targetDeviceId),
  );
  if (new TextEncoder().encode(JSON.stringify(envelope)).length > MAX_ENVELOPE_BYTES) {
    return { ok: false, reason: "too_large" };
  }

  try {
    const { delivered } = await sendTabToServer(targetDeviceId, { id, envelope });
    return delivered ? { ok: true } : { ok: false, reason: "offline" };
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.status === 404) return { ok: false, reason: "device_gone" };
      if (err.status === 429) return { ok: false, reason: "rate_limited" };
    }
    return { ok: false, reason: "failed", message: err instanceof Error ? err.message : String(err) };
  }
}
