// The decrypted vault, in memory only. It is dropped when the keyring locks
// (idle, logout) and never written anywhere.
import { useSyncExternalStore } from "react";
import { ApiError } from "../api/client";
import { LocalizedError } from "../i18n/localized-error";
import { getAccountKey, isUnlocked, onLock, subscribeKeyring } from "./keyring";
import type { VaultData } from "./types";
import { unpackVaultData } from "./wire";
import type { WorkerRequest, WorkerResponse } from "./snapshot.worker";

export type VaultState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; data: VaultData; loadedAt: number }
  | { status: "unsupported" }
  | { status: "error"; error: unknown };

let state: VaultState = { status: "idle" };
let generation = 0;
let activeWorker: Worker | null = null;
const listeners = new Set<() => void>();

function setState(next: VaultState): void {
  state = next;
  for (const listener of [...listeners]) listener();
}

function stopWorker(): void {
  activeWorker?.terminate();
  activeWorker = null;
}

/** Forgets the decrypted data and abandons a load in progress. */
export function clearVault(): void {
  generation += 1;
  stopWorker();
  setState({ status: "idle" });
}

onLock(clearVault);

const API_BASE: string = import.meta.env.VITE_API_BASE_URL ?? "";

/** Downloads the snapshot and decrypts it in a worker. A second call while one
 * is running is ignored. A no-op while locked. */
export function loadVault(): void {
  const key = getAccountKey();
  if (!key || state.status === "loading") return;

  generation += 1;
  const mine = generation;
  setState({ status: "loading" });

  const finish = (next: VaultState): void => {
    if (mine !== generation) return; // locked or reloaded meanwhile
    stopWorker();
    setState(next);
  };

  try {
    const worker = new Worker(new URL("./snapshot.worker.ts", import.meta.url), { type: "module" });
    activeWorker = worker;
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      if (message.ok) {
        finish({ status: "ready", data: unpackVaultData(message.data), loadedAt: Date.now() });
      } else if (message.failure.kind === "unsupported") {
        finish({ status: "unsupported" });
      } else if (message.failure.kind === "http") {
        const { status, code, message: text } = message.failure;
        finish({ status: "error", error: new ApiError(text ?? `request failed (${status})`, status, code) });
      } else {
        finish({ status: "error", error: new Error(message.failure.message) });
      }
    };
    worker.onerror = () => finish({ status: "error", error: new LocalizedError("errors.generic") });
    // A copy: the worker zeroes its own, the keyring keeps (and later zeroes) this one.
    const request: WorkerRequest = { accountKey: key.slice(), apiBase: API_BASE };
    worker.postMessage(request);
  } catch (err) {
    finish({ status: "error", error: err });
  }
}

export function getVaultState(): VaultState {
  return state;
}

export function subscribeVault(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useVaultState(): VaultState {
  return useSyncExternalStore(subscribeVault, getVaultState);
}

/** True while the account key is held. */
export function useUnlocked(): boolean {
  return useSyncExternalStore(subscribeKeyring, isUnlocked);
}
