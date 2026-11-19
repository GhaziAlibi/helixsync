// How decrypted data crosses from the worker to the page. Structured clone of
// hundreds of thousands of small objects freezes the main thread (273 ms for
// 300k history entries in Chromium, several seconds on a phone); the same
// entries as three parallel columns clone about five times faster, and the
// times are transferred, not copied.
import type { VaultData, VaultVisit } from "./types";

export interface PackedHistory {
  urls: string[];
  titles: string[];
  /** Epoch milliseconds. */
  times: Float64Array;
}

export type WireVaultData = Omit<VaultData, "history"> & { history: PackedHistory };

export function packHistory(history: VaultVisit[]): PackedHistory {
  const urls = new Array<string>(history.length);
  const titles = new Array<string>(history.length);
  const times = new Float64Array(history.length);
  for (let i = 0; i < history.length; i++) {
    urls[i] = history[i].url;
    titles[i] = history[i].title;
    times[i] = history[i].t;
  }
  return { urls, titles, times };
}

export function unpackHistory(packed: PackedHistory): VaultVisit[] {
  const out = new Array<VaultVisit>(packed.times.length);
  for (let i = 0; i < out.length; i++) out[i] = { url: packed.urls[i], title: packed.titles[i], t: packed.times[i] };
  return out;
}

export function packVaultData(data: VaultData): WireVaultData {
  return { ...data, history: packHistory(data.history) };
}

export function unpackVaultData(wire: WireVaultData): VaultData {
  return { ...wire, history: unpackHistory(wire.history) };
}
