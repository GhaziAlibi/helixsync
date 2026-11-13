import { listDevices, type DeviceListEntry } from "../api/client";

const CACHE_KEY = "sendTabDevices";

/** The account's other, non-revoked devices (this one excluded). */
export function otherDevices(all: DeviceListEntry[], selfDeviceId: string): DeviceListEntry[] {
  return all.filter((d) => d.id !== selfDeviceId && !d.revokedAt);
}

/** Cached because a context menu can't be built at click time, and because
 * the receiver wants a sender's name without a request. Best-effort. Holds
 * only ids and names. */
export async function cacheDevices(devices: DeviceListEntry[]): Promise<void> {
  try {
    await chrome.storage.session.set({ [CACHE_KEY]: devices.map((d) => ({ id: d.id, name: d.name })) });
  } catch {
    // The cache is only an optimization.
  }
}

export async function cachedDeviceName(deviceId: string): Promise<string | undefined> {
  try {
    const stored = (await chrome.storage.session.get(CACHE_KEY))[CACHE_KEY] as { id: string; name: string }[] | undefined;
    return stored?.find((d) => d.id === deviceId)?.name;
  } catch {
    return undefined;
  }
}

/** A device's display name: the cache, then one request, else undefined. */
export async function deviceName(deviceId: string): Promise<string | undefined> {
  const cached = await cachedDeviceName(deviceId);
  if (cached) return cached;
  try {
    const all = await listDevices();
    await cacheDevices(all.filter((d) => !d.revokedAt));
    return all.find((d) => d.id === deviceId)?.name;
  } catch {
    return undefined;
  }
}
