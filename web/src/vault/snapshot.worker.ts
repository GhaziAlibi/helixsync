// Fetches /sync/snapshot and decrypts it off the main thread, so a large
// history doesn't freeze the page. The account key arrives by message and is
// zeroed when the work ends; the worker is terminated afterwards.
import { UnsupportedEnvelopeVersionError } from "../crypto";
import { decodeSnapshot } from "./decode";
import type { SnapshotWire } from "./types";
import { packVaultData, type WireVaultData } from "./wire";

export interface WorkerRequest {
  accountKey: Uint8Array;
  /** Prefix for API paths (empty when the API is same-origin). */
  apiBase: string;
}

export type WorkerFailure =
  | { kind: "unsupported" }
  | { kind: "http"; status: number; code?: string; message?: string }
  | { kind: "other"; message: string };

export type WorkerResponse = { ok: true; data: WireVaultData } | { ok: false; failure: WorkerFailure };

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
};

scope.onmessage = async (event) => {
  const { accountKey, apiBase } = event.data;
  try {
    const res = await fetch(`${apiBase}/api/v1/sync/snapshot`, { credentials: "include" });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      scope.postMessage({ ok: false, failure: { kind: "http", status: res.status, code: body.error, message: body.message } });
      return;
    }
    const snapshot = (await res.json()) as SnapshotWire;
    const data = packVaultData(await decodeSnapshot(snapshot, accountKey));
    scope.postMessage({ ok: true, data }, [data.history.times.buffer]);
  } catch (err) {
    scope.postMessage({
      ok: false,
      failure:
        err instanceof UnsupportedEnvelopeVersionError
          ? { kind: "unsupported" }
          : { kind: "other", message: err instanceof Error ? err.message : String(err) },
    });
  } finally {
    accountKey.fill(0);
  }
};
