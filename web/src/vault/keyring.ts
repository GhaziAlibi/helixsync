// The account key, in a module-level variable and nowhere else: not React
// state, not storage. A page reload, an auto-lock or a logout drops it, and the
// Vault page then asks for the password again.
//
// Nothing in src/vault writes to localStorage, sessionStorage, IndexedDB or a
// cache (keyring.test.ts checks).

/** How long without a click, key press or touch before the vault locks. */
export const IDLE_LOCK_MS = 5 * 60 * 1000;
const IDLE_CHECK_INTERVAL_MS = 10 * 1000;
const ACTIVITY_EVENTS = ["pointerdown", "keydown", "touchstart", "wheel"] as const;

let accountKey: Uint8Array | null = null;
let lastActivityAt = 0;
let idleTimer: ReturnType<typeof setInterval> | null = null;

const changeListeners = new Set<() => void>();
const lockListeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...changeListeners]) listener();
}

function onActivity(): void {
  lastActivityAt = Date.now();
}

function eventTarget(): EventTarget | undefined {
  return typeof window === "undefined" ? undefined : window;
}

function startIdleWatch(): void {
  stopIdleWatch();
  lastActivityAt = Date.now();
  const target = eventTarget();
  for (const name of ACTIVITY_EVENTS) target?.addEventListener(name, onActivity, { passive: true });
  idleTimer = setInterval(() => {
    if (Date.now() - lastActivityAt >= IDLE_LOCK_MS) lockVault();
  }, IDLE_CHECK_INTERVAL_MS);
}

function stopIdleWatch(): void {
  if (idleTimer !== null) clearInterval(idleTimer);
  idleTimer = null;
  const target = eventTarget();
  for (const name of ACTIVITY_EVENTS) target?.removeEventListener(name, onActivity);
}

/** Keeps `key` (the 32-byte account key) in memory and starts the idle lock.
 * The array is owned by the keyring from here on and zeroed when it locks. */
export function setAccountKey(key: Uint8Array): void {
  if (accountKey && accountKey !== key) accountKey.fill(0);
  accountKey = key;
  startIdleWatch();
  notify();
}

/** The held account key, or null when locked. Don't keep the result. */
export function getAccountKey(): Uint8Array | null {
  return accountKey;
}

export function isUnlocked(): boolean {
  return accountKey !== null;
}

/** Drops the account key and everything decrypted with it. Safe to call when
 * already locked. */
export function lockVault(): void {
  if (accountKey) accountKey.fill(0);
  accountKey = null;
  stopIdleWatch();
  for (const listener of [...lockListeners]) listener();
  notify();
}

/** Runs `listener` on every lock, so the decrypted data goes with the key. */
export function onLock(listener: () => void): () => void {
  lockListeners.add(listener);
  return () => lockListeners.delete(listener);
}

/** For `useSyncExternalStore`: called when the key is set or dropped. */
export function subscribeKeyring(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}
