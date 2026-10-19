import {
  ApiError,
  registerDevice,
  prelogin,
  fetchSettings,
  updateSettings,
  invalidateSettingsCache,
  revokeThisDevice,
  createAuthRequest,
  pollAuthRequest,
  listAuthRequests,
  respondAuthRequest,
  type PendingAuthRequest,
  type UpdateSettingsRequest,
  type UserSettingsDto,
} from "../api/client";
import {
  clearAllLocalData,
  getDevice,
  getPendingTabRestores,
  getPendingTabRestoresPage,
  putDevice,
  type DeviceRecord,
} from "../storage/db";
import type { PendingTabRestore } from "../storage/selectors";
import {
  ensureCryptoReady,
  deriveMasterKey,
  deriveAuthKey,
  deriveKek,
  unwrapAccountKey,
  fromB64,
  toB64,
  accountKeyCheckPhrase,
  authRequestFingerprint,
  decryptAccountKeyFromApproval,
  encryptAccountKeyForRequest,
  generateAuthRequestKeyPair,
} from "../crypto";
import { assertSecureServerUrl, InsecureServerUrlError } from "./serverUrl";

/** The https origin and its wss counterpart (for the WebSocket channel),
 * requested together so the user is prompted only once. */
function hostPermissionOrigins(serverUrl: string): string[] {
  const url = new URL(serverUrl);
  const wsScheme = url.protocol === "https:" ? "wss:" : "ws:";
  return [`${url.origin}/*`, `${wsScheme}//${url.host}/*`];
}

const app = document.getElementById("app")!;
const headerActions = document.getElementById("header-actions")!;

// The popup is the extension's only UI; "settings" is reached from "status"
// through the header gear.
type ConnectedView = "status" | "settings";
let connectedView: ConnectedView = "status";

// Registration happens server-side before the slow key derivation finishes,
// so a double submit (or a click racing the pending-connect resume) would
// create two device rows for one browser.
let connectInFlight = false;

// Chrome destroys the popup whenever it loses focus, so in-progress form
// input is saved to chrome.storage.local as the user types and restored on
// the next open.
const SETUP_DRAFT_KEY = "setupDraft";
const SETTINGS_DRAFT_KEY = "settingsDraft";
// SEC-12: the password goes to chrome.storage.session (memory-only, cleared
// when the browser exits), never to chrome.storage.local on disk.
const SETUP_PASSWORD_KEY = "setupDraftPassword";
// A waiting login-with-device request, private key included: also
// chrome.storage.session only, for the same reason.
const DEVICE_LOGIN_KEY = "pendingDeviceLogin";
const DEVICE_LOGIN_POLL_MS = 3000;

interface SetupDraft {
  serverUrl?: string;
  email?: string;
  deviceName?: string;
  // The permission dialog steals focus and Chrome destroys the popup,
  // killing the connect attempt. These flags let the next open resume it.
  pendingConnect?: boolean;
  pendingDeviceLogin?: boolean;
}

/** A "Log in with device" request this browser is waiting on
 * (docs/protocol.md §7.4). */
interface PendingDeviceLogin {
  serverUrl: string;
  email: string;
  deviceName: string;
  requestId: string;
  secret: string;
  expiresAt: string;
  publicKey: string;
  privateKeyJwk: JsonWebKey;
}

async function loadPendingDeviceLogin(): Promise<PendingDeviceLogin | undefined> {
  const result = await chrome.storage.session.get(DEVICE_LOGIN_KEY);
  return result[DEVICE_LOGIN_KEY] as PendingDeviceLogin | undefined;
}

async function clearPendingDeviceLogin(): Promise<void> {
  await chrome.storage.session.remove(DEVICE_LOGIN_KEY);
}

async function loadPasswordDraft(): Promise<string | undefined> {
  const result = await chrome.storage.session.get(SETUP_PASSWORD_KEY);
  return result[SETUP_PASSWORD_KEY] as string | undefined;
}

async function savePasswordDraft(password: string): Promise<void> {
  await chrome.storage.session.set({ [SETUP_PASSWORD_KEY]: password });
}

async function clearPasswordDraft(): Promise<void> {
  await chrome.storage.session.remove(SETUP_PASSWORD_KEY);
}

const SYNC_TOGGLE_IDS = ["syncBookmarks", "syncHistory", "syncTabs", "syncTabGroups"] as const;
type SyncToggleId = (typeof SYNC_TOGGLE_IDS)[number];
const SETTINGS_SELECT_IDS = ["tabRestorePolicy", "historyRetention"] as const;

type SettingsForm = Pick<UserSettingsDto, SyncToggleId | "tabRestorePolicy" | "historyRetention">;
type SettingsDraft = Partial<Record<SyncToggleId, boolean> & Record<"tabRestorePolicy" | "historyRetention", string>>;

async function loadDraft<T>(key: string): Promise<T | undefined> {
  const result = await chrome.storage.local.get(key);
  return result[key] as T | undefined;
}

async function saveDraft<T>(key: string, draft: T): Promise<void> {
  await chrome.storage.local.set({ [key]: draft });
}

async function clearDraft(key: string): Promise<void> {
  await chrome.storage.local.remove(key);
}

// Trailing debounce so typing doesn't write to disk on every keystroke.
// Submit and save paths call saveDraft directly, so nothing is lost if the
// popup closes mid-debounce.
const DRAFT_DEBOUNCE_MS = 400;
const draftDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

function saveDraftDebounced<T>(key: string, draft: T): void {
  const existing = draftDebounceTimers.get(key);
  if (existing !== undefined) clearTimeout(existing);
  draftDebounceTimers.set(
    key,
    setTimeout(() => {
      draftDebounceTimers.delete(key);
      void saveDraft(key, draft);
    }, DRAFT_DEBOUNCE_MS),
  );
}

function inputById(id: string): HTMLInputElement {
  return document.getElementById(id) as HTMLInputElement;
}

function selectById(id: string): HTMLSelectElement {
  return document.getElementById(id) as HTMLSelectElement;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function showError(status: HTMLElement, message: string): void {
  status.classList.add("error");
  status.textContent = message;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// window.confirm() ignores the popup's fixed width and can clip its buttons
// out of reach, so the dialog is rendered inside the popup instead.
function showConfirmDialog(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal-card">
        <p>${escapeAttr(message)}</p>
        <div class="modal-actions">
          <button class="ghost" id="modal-cancel">Cancel</button>
          <button class="danger" id="modal-confirm">Disconnect</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const close = (result: boolean) => {
      overlay.remove();
      resolve(result);
    };
    overlay.querySelector("#modal-cancel")!.addEventListener("click", () => close(false));
    overlay.querySelector("#modal-confirm")!.addEventListener("click", () => close(true));
  });
}

const GEAR_ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82A1.65 1.65 0 0 0 3 9.09H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 4.6a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/></svg>';
const BACK_ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg>';

function timeAgo(iso?: string): string {
  if (!iso) return "never";
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds} seconds ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"} ago`;
}

function statusDotClass(status: string): string {
  if (status === "syncing") return "syncing";
  if (status === "error" || status === "needs_reauth") return "error";
  return "synced";
}

function statusLabel(status: string): string {
  switch (status) {
    case "syncing":
      return "Syncing…";
    case "error":
      return "Sync error";
    case "needs_reauth":
      return "Needs re-authorization";
    default:
      return "Synced";
  }
}

function defaultDeviceName(): string {
  const ua = navigator.userAgent;
  const platform = /Windows/.test(ua) ? "Windows" : /Mac/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "Device";
  return `${platform} - Helium`;
}

// Rendering every pending tab would make each popup open janky for devices
// with hundreds of tabs; the rest load on "Show more".
const PENDING_RESTORE_PAGE_SIZE = 15;

/** The "ask" policy's list of remote tabs awaiting restore, with per-tab
 * "Restore" and "Restore all" (built with DOM APIs, not innerHTML, because
 * titles and URLs come from other devices and must never be parsed as
 * markup). Rows already shown are skipped when the rest arrive, so a
 * restore racing "Show more" can't duplicate one. */
function renderPendingTabRestores(
  initial: PendingTabRestore[],
  totalCount: number,
  loadRemaining: () => Promise<PendingTabRestore[]>,
  onRestore: (objectId: string) => Promise<void>,
  onRestoreAll: () => void,
): HTMLElement | null {
  if (initial.length === 0 && totalCount === 0) return null;

  const section = document.createElement("div");
  const label = document.createElement("div");
  label.className = "section-label";
  const restoreAllButton = document.createElement("button");
  let remainingCount = totalCount;
  const updateCount = () => {
    label.textContent = `Tabs from other devices (${remainingCount})`;
    restoreAllButton.textContent = `Restore all (${remainingCount})`;
  };
  updateCount();
  section.appendChild(label);

  const list = document.createElement("ul");
  list.className = "item-list";

  const showRestoreError = (err: unknown) => {
    let error = section.querySelector<HTMLElement>(".restore-error");
    if (!error) {
      error = document.createElement("div");
      error.className = "status-message error restore-error";
      section.appendChild(error);
    }
    error.textContent = `Failed to restore tab: ${errorMessage(err)}`;
  };

  const renderedObjectIds = new Set<string>();
  const appendItem = ({ objectId, payload }: PendingTabRestore) => {
    if (renderedObjectIds.has(objectId)) return;
    renderedObjectIds.add(objectId);
    const item = document.createElement("li");
    item.className = "item restore-item";

    const info = document.createElement("div");
    info.className = "item-title";
    info.textContent = payload.title || payload.url;
    info.title = payload.url;

    const restoreButton = document.createElement("button");
    restoreButton.className = "restore-button";
    restoreButton.textContent = "Restore";
    restoreButton.addEventListener("click", () => {
      void (async () => {
        restoreButton.disabled = true;
        restoreButton.textContent = "Restoring…";
        section.querySelector(".restore-error")?.remove();
        try {
          await onRestore(objectId);
          item.remove();
          remainingCount--;
          if (remainingCount === 0) {
            section.remove();
          } else {
            updateCount();
          }
        } catch (err) {
          // Keep the row so the user can retry.
          restoreButton.disabled = false;
          restoreButton.textContent = "Restore";
          showRestoreError(err);
        }
      })();
    });

    item.append(info, restoreButton);
    list.appendChild(item);
  };

  for (const entry of initial) {
    appendItem(entry);
  }
  section.appendChild(list);

  if (totalCount > initial.length) {
    const hiddenAtRender = totalCount - initial.length;
    const showMoreButton = document.createElement("button");
    showMoreButton.className = "ghost";
    showMoreButton.textContent = `Show ${hiddenAtRender} more`;
    showMoreButton.addEventListener("click", () => {
      showMoreButton.disabled = true;
      void (async () => {
        try {
          const full = await loadRemaining();
          for (const entry of full) appendItem(entry);
          showMoreButton.remove();
        } catch {
          showMoreButton.disabled = false;
        }
      })();
    });
    section.appendChild(showMoreButton);
  }

  restoreAllButton.addEventListener("click", onRestoreAll);
  section.appendChild(restoreAllButton);

  return section;
}

async function render(): Promise<void> {
  stopDeviceLoginPolling();
  const device = await getDevice();
  if (!device) {
    headerActions.innerHTML = "";
    const pendingLogin = await loadPendingDeviceLogin();
    if (pendingLogin) {
      await renderDeviceLoginWait(pendingLogin);
    } else {
      await renderSetup();
    }
    return;
  }
  if (connectedView === "settings") {
    await renderSettings(device);
  } else {
    await renderStatusView(device);
  }
}

interface ConnectInput {
  serverUrl: string;
  email: string;
  password: string;
  deviceName: string;
}

async function renderSetup(): Promise<void> {
  const draft = (await loadDraft<SetupDraft>(SETUP_DRAFT_KEY)) ?? {};
  const password = (await loadPasswordDraft()) ?? "";

  app.innerHTML = `
    <h2 class="view-title">Connect this browser</h2>
    <p class="view-subtitle">Sign in with your HelixSync account to start syncing.</p>
    <form id="setup-form">
      <label class="field">
        <span>Server URL</span>
        <input type="text" id="serverUrl" placeholder="https://sync.example.com" value="${escapeAttr(draft.serverUrl ?? "")}" required />
      </label>
      <label class="field">
        <span>Email</span>
        <input type="email" id="email" value="${escapeAttr(draft.email ?? "")}" required />
      </label>
      <label class="field">
        <span>Password</span>
        <input type="password" id="password" value="${escapeAttr(password)}" required />
      </label>
      <label class="field">
        <span>Device name</span>
        <input type="text" id="deviceName" value="${escapeAttr(draft.deviceName ?? defaultDeviceName())}" required />
      </label>
      <button type="submit" class="primary">Connect</button>
      <button type="button" id="device-login" class="ghost">Log in with device instead</button>
    </form>
    <p class="view-subtitle">
      Don't have an account? <a href="#" id="register-link">Register on the web</a>
    </p>
    <p class="view-subtitle">
      <a href="#" id="forgot-password-link">Forgot your password?</a>
    </p>
    <div class="status-message" id="status"></div>
  `;

  const form = document.getElementById("setup-form") as HTMLFormElement;
  const status = document.getElementById("status")!;

  // Both links open a dashboard page on the server typed into the form.
  const openDashboardPage = (path: string) => {
    const serverUrl = inputById("serverUrl").value.trim();
    status.classList.remove("error");

    let origin: string;
    try {
      origin = new URL(serverUrl).origin;
    } catch {
      showError(status, "Enter a valid Server URL first.");
      return;
    }

    void chrome.tabs.create({ url: `${origin}${path}` });
  };

  document.getElementById("register-link")?.addEventListener("click", (e) => {
    e.preventDefault();
    openDashboardPage("/login?mode=register");
  });
  document.getElementById("forgot-password-link")?.addEventListener("click", (e) => {
    e.preventDefault();
    openDashboardPage("/recover");
  });

  const persistDraft = () => {
    saveDraftDebounced<SetupDraft>(SETUP_DRAFT_KEY, {
      serverUrl: inputById("serverUrl").value,
      email: inputById("email").value,
      deviceName: inputById("deviceName").value,
    });
  };
  for (const id of ["serverUrl", "email", "deviceName"]) {
    document.getElementById(id)?.addEventListener("input", persistDraft);
  }
  document.getElementById("password")?.addEventListener("input", () => {
    void savePasswordDraft(inputById("password").value);
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (connectInFlight) return;
    connectInFlight = true;
    const submitButton = form.querySelector<HTMLButtonElement>('button[type="submit"]');
    submitButton?.setAttribute("disabled", "");

    try {
      const serverUrl = inputById("serverUrl").value.replace(/\/$/, "");
      const email = inputById("email").value;
      const password = inputById("password").value;
      const deviceName = inputById("deviceName").value;

      status.classList.remove("error");
      let origins: string[];
      try {
        assertSecureServerUrl(serverUrl);
        origins = hostPermissionOrigins(serverUrl);
      } catch (err) {
        showError(status, err instanceof InsecureServerUrlError ? err.message : "Enter a valid Server URL.");
        return;
      }

      // Not awaited: chrome.permissions.request() must run inside the click's
      // user gesture, and any prior await consumes it. The writes still land
      // even if the permission prompt then destroys the popup.
      void saveDraft<SetupDraft>(SETUP_DRAFT_KEY, { serverUrl, email, deviceName, pendingConnect: true });
      void savePasswordDraft(password);

      const granted = await chrome.permissions.request({ origins });
      if (!granted) {
        await saveDraft<SetupDraft>(SETUP_DRAFT_KEY, { serverUrl, email, deviceName, pendingConnect: false });
        showError(status, "Permission to contact the server was not granted.");
        return;
      }

      await attemptConnect({ serverUrl, email, password, deviceName }, status);
    } finally {
      connectInFlight = false;
      submitButton?.removeAttribute("disabled");
    }
  });

  document.getElementById("device-login")?.addEventListener("click", async () => {
    if (connectInFlight) return;
    const serverUrl = inputById("serverUrl").value.replace(/\/$/, "");
    const email = inputById("email").value;
    const deviceName = inputById("deviceName").value;

    status.classList.remove("error");
    if (!email.includes("@") || !deviceName.trim()) {
      showError(status, "Enter your email and a device name first.");
      return;
    }
    let origins: string[];
    try {
      assertSecureServerUrl(serverUrl);
      origins = hostPermissionOrigins(serverUrl);
    } catch (err) {
      showError(status, err instanceof InsecureServerUrlError ? err.message : "Enter a valid Server URL.");
      return;
    }

    // Same gesture rule as Connect: no await before the permission request.
    void saveDraft<SetupDraft>(SETUP_DRAFT_KEY, { serverUrl, email, deviceName, pendingDeviceLogin: true });
    const granted = await chrome.permissions.request({ origins });
    if (!granted) {
      await saveDraft<SetupDraft>(SETUP_DRAFT_KEY, { serverUrl, email, deviceName, pendingDeviceLogin: false });
      showError(status, "Permission to contact the server was not granted.");
      return;
    }
    await startDeviceLogin({ serverUrl, email, deviceName }, status);
  });

  if (draft.pendingConnect && draft.serverUrl && draft.email && password) {
    await resumePendingConnect(draft, password, status);
  } else if (draft.pendingDeviceLogin && draft.serverUrl && draft.email && draft.deviceName) {
    await resumePendingDeviceLogin(draft, status);
  }
}

/** Starts a device login that the permission dialog interrupted by
 * destroying the popup, if the permission ended up granted. */
async function resumePendingDeviceLogin(draft: SetupDraft, status: HTMLElement): Promise<void> {
  await saveDraft<SetupDraft>(SETUP_DRAFT_KEY, { ...draft, pendingDeviceLogin: false });
  let origins: string[];
  try {
    assertSecureServerUrl(draft.serverUrl!);
    origins = hostPermissionOrigins(draft.serverUrl!);
  } catch {
    return;
  }
  if (!(await chrome.permissions.contains({ origins }))) {
    showError(status, "Permission wasn't granted last time — click \"Log in with device instead\" to try again.");
    return;
  }
  await startDeviceLogin(
    { serverUrl: draft.serverUrl!, email: draft.email!, deviceName: draft.deviceName! },
    status,
  );
}

/** Creates the request and switches to the waiting view. Callers must have
 * the host permission already. */
async function startDeviceLogin(
  input: { serverUrl: string; email: string; deviceName: string },
  status: HTMLElement,
): Promise<void> {
  if (connectInFlight) return;
  connectInFlight = true;
  status.classList.remove("error");
  status.textContent = "Creating sign-in request…";
  try {
    const keyPair = await generateAuthRequestKeyPair();
    const created = await createAuthRequest(input.serverUrl, input.email, keyPair.publicKey, input.deviceName);
    const pending: PendingDeviceLogin = {
      ...input,
      requestId: created.id,
      secret: created.secret,
      expiresAt: created.expiresAt,
      publicKey: keyPair.publicKey,
      privateKeyJwk: keyPair.privateKeyJwk,
    };
    await chrome.storage.session.set({ [DEVICE_LOGIN_KEY]: pending });
    await saveDraft<SetupDraft>(SETUP_DRAFT_KEY, { ...input, pendingDeviceLogin: false });
  } catch (err) {
    showError(status, `Failed: ${errorMessage(err)}`);
    return;
  } finally {
    connectInFlight = false;
  }
  await render();
}

let deviceLoginPollTimer: ReturnType<typeof setTimeout> | undefined;

function stopDeviceLoginPolling(): void {
  clearTimeout(deviceLoginPollTimer);
  deviceLoginPollTimer = undefined;
}

/** Back to the setup form, with `message` explaining why. */
async function abandonDeviceLogin(message?: string): Promise<void> {
  await clearPendingDeviceLogin();
  await render();
  if (message) {
    const status = document.getElementById("status");
    if (status) showError(status, message);
  }
}

/** Waits for another browser to approve, polling while the popup is open.
 * Reopening the popup resumes here, since the request lives in session
 * storage. */
async function renderDeviceLoginWait(pending: PendingDeviceLogin): Promise<void> {
  app.innerHTML = `
    <h2 class="view-title">Approve on another browser</h2>
    <p class="view-subtitle">
      Open HelixSync on a browser that's already connected to this account and approve the request there.
      Approve it only if that browser shows this phrase:
    </p>
    <div class="fingerprint" id="fingerprint"></div>
    <div class="status-message" id="status">Waiting for approval…</div>
    <button id="cancel-device-login" class="ghost">Cancel</button>
  `;
  document.getElementById("fingerprint")!.textContent = await authRequestFingerprint(pending.publicKey);
  const status = document.getElementById("status")!;
  document.getElementById("cancel-device-login")?.addEventListener("click", () => {
    void abandonDeviceLogin();
  });

  const tick = async () => {
    deviceLoginPollTimer = undefined;
    try {
      const result = await pollAuthRequest(pending.serverUrl, pending.requestId, pending.secret, {
        browser: "helium",
        extensionVersion: chrome.runtime.getManifest().version,
      });
      if (result.status === "approved") {
        const accountKey = await decryptAccountKeyFromApproval(
          pending.privateKeyJwk,
          result.approverPublicKey,
          result.encryptedAccountKey,
          pending.requestId,
        );
        // The server relays the approval and could have fabricated it. Only
        // the approving browser knows the real account key, so the user
        // checks the phrase derived from it before this browser adopts it.
        await renderKeyCheck(await accountKeyCheckPhrase(accountKey), {
          onMatch: async () => {
            await clearPendingDeviceLogin();
            // Connected some other way in the meantime: keep that connection.
            if (await getDevice()) {
              await render();
              return;
            }
            await finishConnect({ serverUrl: pending.serverUrl, email: pending.email }, result, toB64(accountKey));
          },
          onMismatch: () => abandonDeviceLogin("The key check didn't match, so the approval was discarded."),
        });
        return;
      }
      if (result.status === "denied") {
        await abandonDeviceLogin("The sign-in request was denied.");
        return;
      }
      if (result.status === "expired") {
        await abandonDeviceLogin("The sign-in request expired. Start a new one.");
        return;
      }
    } catch (err) {
      // The approval stays collectable until the request expires, so the
      // device cap and transient failures just show and keep waiting.
      status.classList.add("error");
      status.textContent =
        err instanceof ApiError && err.code === "device_limit_reached"
          ? "This account has the maximum number of devices. Revoke one on the dashboard and this browser will connect."
          : `Still waiting: ${errorMessage(err)}`;
    }
    if (Date.now() >= Date.parse(pending.expiresAt)) {
      await abandonDeviceLogin("The sign-in request expired. Start a new one.");
      return;
    }
    deviceLoginPollTimer = setTimeout(() => void tick(), DEVICE_LOGIN_POLL_MS);
  };
  deviceLoginPollTimer = setTimeout(() => void tick(), DEVICE_LOGIN_POLL_MS);
}

/** Shows the key-check phrase of a received approval and waits for the user
 * to confirm it matches the one on the approving browser. */
async function renderKeyCheck(
  phrase: string,
  handlers: { onMatch: () => Promise<void>; onMismatch: () => Promise<void> },
): Promise<void> {
  app.innerHTML = `
    <h2 class="view-title">Check the key</h2>
    <p class="view-subtitle">
      The approving browser shows a key check phrase on its sign-in request. Continue only if it matches:
    </p>
    <div class="fingerprint" id="key-check"></div>
    <div class="status-message" id="status"></div>
    <button id="key-check-match" class="primary">It matches</button>
    <button id="key-check-mismatch">It doesn't match</button>
  `;
  document.getElementById("key-check")!.textContent = phrase;
  const status = document.getElementById("status")!;
  const match = document.getElementById("key-check-match") as HTMLButtonElement;
  const mismatch = document.getElementById("key-check-mismatch") as HTMLButtonElement;
  const run = (handler: () => Promise<void>) => async () => {
    match.disabled = true;
    mismatch.disabled = true;
    try {
      await handler();
    } catch (err) {
      showError(status, errorMessage(err));
      match.disabled = false;
      mismatch.disabled = false;
    }
  };
  match.addEventListener("click", () => void run(handlers.onMatch)());
  mismatch.addEventListener("click", () => void run(handlers.onMismatch)());
}

/** Finishes a connect that the permission dialog interrupted by destroying
 * the popup, if the permission ended up granted. */
async function resumePendingConnect(draft: SetupDraft, password: string, status: HTMLElement): Promise<void> {
  const serverUrl = draft.serverUrl!;
  let origins: string[];
  try {
    assertSecureServerUrl(serverUrl);
    origins = hostPermissionOrigins(serverUrl);
  } catch (err) {
    await saveDraft<SetupDraft>(SETUP_DRAFT_KEY, { ...draft, pendingConnect: false });
    if (err instanceof InsecureServerUrlError) {
      showError(status, err.message);
    }
    return;
  }

  const alreadyGranted = await chrome.permissions.contains({ origins });
  if (!alreadyGranted) {
    await saveDraft<SetupDraft>(SETUP_DRAFT_KEY, { ...draft, pendingConnect: false });
    showError(status, "Permission wasn't granted last time — click Connect to try again.");
    return;
  }
  if (connectInFlight) return;
  connectInFlight = true;
  try {
    await attemptConnect(
      {
        serverUrl,
        email: draft.email!,
        password,
        deviceName: draft.deviceName ?? defaultDeviceName(),
      },
      status,
    );
  } finally {
    connectInFlight = false;
  }
}

/** Callers must request the host permission first: it needs an unbroken
 * user-gesture chain, which the awaits here would break. */
async function attemptConnect(input: ConnectInput, status: HTMLElement): Promise<void> {
  const { serverUrl, email, password, deviceName } = input;
  status.classList.remove("error");
  status.textContent = "Connecting…";

  try {
    await ensureCryptoReady();

    // SEC-01 / docs/encryption.md §2: the password never leaves the device.
    // It derives the authKey (sent in place of the password) and the KEK
    // (unwraps the account key, never sent).
    status.textContent = "Deriving encryption key…";
    const { kdfSalt, kdfParams } = await prelogin(serverUrl, email);
    const masterKey = await deriveMasterKey(password, kdfSalt, kdfParams);
    const authKey = await deriveAuthKey(masterKey);
    const kek = await deriveKek(masterKey);

    status.textContent = "Connecting…";
    const result = await registerDevice({
      serverUrl,
      email,
      authKey,
      name: deviceName,
      browser: "helium",
      extensionVersion: chrome.runtime.getManifest().version,
    });

    const accountKey = toB64(unwrapAccountKey(kek, result.wrappedAccountKey));
    await finishConnect({ serverUrl, email }, result, accountKey);
  } catch (err) {
    await saveDraft<SetupDraft>(SETUP_DRAFT_KEY, { serverUrl, email, deviceName, pendingConnect: false });
    showError(status, `Failed: ${errorMessage(err)}`);
  }
}

/** Stores the new device's credentials and account key, shared by password
 * connect and login with device. */
async function finishConnect(
  account: { serverUrl: string; email: string },
  credentials: {
    deviceId: string;
    accessToken: string;
    accessTokenExpiresAt: string;
    refreshToken: string;
    accountKeyVersion: number;
  },
  accountKey: string,
): Promise<void> {
  const record: DeviceRecord = {
    id: "self",
    serverUrl: account.serverUrl,
    deviceId: credentials.deviceId,
    userId: "",
    email: account.email,
    accessToken: credentials.accessToken,
    accessTokenExpiresAt: credentials.accessTokenExpiresAt,
    refreshToken: credentials.refreshToken,
    accountKey,
    accountKeyVersion: credentials.accountKeyVersion,
  };
  await putDevice(record);
  await clearDraft(SETUP_DRAFT_KEY);
  await clearPasswordDraft();

  // The worker's startup already ran without a device, so it has to be
  // told to start capture, the initial import and the WebSocket. Not
  // awaited: the worker replies only after the import, which can take
  // minutes.
  void chrome.runtime.sendMessage({ type: "REFRESH_CAPTURE_CONFIG" }).catch(() => {});

  connectedView = "status";
  await render();
}

function renderHeaderButton(id: string, title: string, icon: string, targetView: ConnectedView): void {
  headerActions.innerHTML = `<button class="icon-button" id="${id}" title="${title}">${icon}</button>`;
  document.getElementById(id)?.addEventListener("click", async () => {
    connectedView = targetView;
    await render();
  });
}

async function renderStatusView(device: DeviceRecord): Promise<void> {
  renderHeaderButton("open-settings", "Settings", GEAR_ICON, "settings");

  const [response, settings, authRequests] = await Promise.all([
    chrome.runtime.sendMessage({ type: "GET_STATUS" }),
    fetchSettings().catch(() => undefined),
    listAuthRequests().catch((): PendingAuthRequest[] => []),
  ]);

  app.innerHTML = `
    <div class="status-card">
      <span class="dot ${statusDotClass(response.status)}"></span>
      <div class="status-text">
        <strong>${statusLabel(response.status)}</strong>
        <span>Last sync: ${timeAgo(response.lastSyncAt)} · Pending: ${response.pendingCount ?? 0}</span>
      </div>
    </div>
    <button id="sync-now" class="primary">Sync Now</button>
  `;

  // The detail is an error message that can echo server text, so it's set
  // as textContent, never markup.
  if ((response.status === "error" || response.status === "needs_reauth") && response.errorDetail) {
    const detail = document.createElement("div");
    detail.className = "status-message error";
    detail.textContent = response.errorDetail;
    document.querySelector(".status-card")!.insertAdjacentElement("afterend", detail);
  }

  if (authRequests.length > 0) {
    document
      .getElementById("sync-now")!
      .insertAdjacentElement("beforebegin", await renderAuthRequests(device, authRequests));
  }

  document.getElementById("sync-now")?.addEventListener("click", async (e) => {
    const button = e.currentTarget as HTMLButtonElement;
    button.disabled = true;
    button.textContent = "Syncing…";
    try {
      await chrome.runtime.sendMessage({ type: "SYNC_NOW" });
    } finally {
      await render();
    }
  });

  if (settings?.tabRestorePolicy === "ask") {
    const { items: initial, total: totalCount } = await getPendingTabRestoresPage(PENDING_RESTORE_PAGE_SIZE);
    const restoreSection = renderPendingTabRestores(
      initial,
      totalCount,
      () => getPendingTabRestores(),
      async (objectId) => {
        const response = await chrome.runtime.sendMessage({ type: "RESTORE_TAB", objectId });
        // The worker reports failures in the response rather than rejecting.
        if (!response?.ok) {
          throw new Error(response?.error ?? "The restore request failed");
        }
      },
      async () => {
        await chrome.runtime.sendMessage({ type: "RESTORE_ALL_TABS" });
        await render();
      },
    );
    if (restoreSection) app.appendChild(restoreSection);
  }

  const footer = document.createElement("div");
  footer.className = "meta";
  footer.style.marginTop = "16px";
  footer.style.textAlign = "center";
  footer.textContent = `Signed in as ${device.email}`;
  app.appendChild(footer);
}

/** Sign-in requests waiting for this account's approval (login with device,
 * docs/protocol.md §7.4). Built with DOM APIs, not innerHTML: the device
 * name and user agent come from whoever made the request. */
async function renderAuthRequests(device: DeviceRecord, requests: PendingAuthRequest[]): Promise<HTMLElement> {
  const section = document.createElement("div");
  const label = document.createElement("div");
  label.className = "section-label";
  label.textContent = requests.length === 1 ? "Sign-in request" : "Sign-in requests";
  section.appendChild(label);

  for (const request of requests) {
    const card = document.createElement("div");
    card.className = "auth-request";

    const title = document.createElement("div");
    title.className = "item-title";
    title.textContent =
      request.kind === "web" ? "Web dashboard sign-in" : `New browser: ${request.deviceName ?? "unnamed"}`;

    const meta = document.createElement("div");
    meta.className = "item-meta";
    meta.textContent = `${request.requestIp ?? "Unknown IP"} · ${timeAgo(request.createdAt)}`;
    if (request.userAgent) meta.title = request.userAgent;

    const consequence = document.createElement("div");
    consequence.className = "item-meta";
    consequence.textContent =
      request.kind === "web"
        ? "Approving signs that browser in to your dashboard."
        : "Approving gives that browser your encryption key and all your synced data.";

    const prompt = document.createElement("div");
    prompt.className = "item-meta";
    prompt.textContent = "Approve only if the other screen shows:";

    const fingerprint = document.createElement("div");
    fingerprint.className = "fingerprint";
    fingerprint.textContent = await authRequestFingerprint(request.publicKey);

    const keyCheckParts: HTMLElement[] = [];
    if (request.kind === "device") {
      const keyCheckLabel = document.createElement("div");
      keyCheckLabel.className = "item-meta";
      keyCheckLabel.textContent = "After you approve, the new browser asks you to confirm this key check phrase:";
      const keyCheck = document.createElement("div");
      keyCheck.className = "fingerprint";
      keyCheck.textContent = await accountKeyCheckPhrase(fromB64(device.accountKey));
      keyCheckParts.push(keyCheckLabel, keyCheck);
    }

    const actions = document.createElement("div");
    actions.className = "auth-actions";
    const approve = document.createElement("button");
    approve.className = "primary";
    approve.textContent = "Approve";
    const deny = document.createElement("button");
    deny.textContent = "Deny";
    actions.append(approve, deny);

    const error = document.createElement("div");
    error.className = "status-message error";

    const answer = async (approved: boolean) => {
      approve.disabled = true;
      deny.disabled = true;
      error.textContent = "";
      try {
        if (approved && request.kind === "device") {
          const keys = await encryptAccountKeyForRequest(device.accountKey, request.publicKey, request.id);
          await respondAuthRequest(request.id, { approve: true, ...keys });
        } else {
          await respondAuthRequest(request.id, { approve: approved });
        }
        await render();
      } catch (err) {
        error.textContent =
          err instanceof ApiError && err.status === 404
            ? "This request was already answered or has expired."
            : `Failed: ${errorMessage(err)}`;
        approve.disabled = false;
        deny.disabled = false;
      }
    };
    approve.addEventListener("click", () => void answer(true));
    deny.addEventListener("click", () => void answer(false));

    card.append(title, meta, consequence, prompt, fingerprint, ...keyCheckParts, actions, error);
    section.appendChild(card);
  }
  return section;
}

function readSettingsForm(): SettingsForm {
  return {
    syncBookmarks: inputById("syncBookmarks").checked,
    syncHistory: inputById("syncHistory").checked,
    syncTabs: inputById("syncTabs").checked,
    syncTabGroups: inputById("syncTabGroups").checked,
    tabRestorePolicy: selectById("tabRestorePolicy").value as SettingsForm["tabRestorePolicy"],
    historyRetention: selectById("historyRetention").value as SettingsForm["historyRetention"],
  };
}

/** An unsaved draft (from a popup closed before "Save") wins over the
 * server's values, so the user's edits aren't lost. */
function fillSettingsForm(settings: UserSettingsDto, draft: SettingsDraft): void {
  for (const id of SYNC_TOGGLE_IDS) {
    inputById(id).checked = draft[id] ?? settings[id];
  }
  for (const id of SETTINGS_SELECT_IDS) {
    selectById(id).value = draft[id] ?? settings[id];
  }
}

async function renderSettings(device: DeviceRecord): Promise<void> {
  renderHeaderButton("back-to-status", "Back", BACK_ICON, "status");

  app.innerHTML = `
    <div class="account-row">
      <span class="email">${escapeAttr(device.email)}</span>
      <button id="disconnect" class="danger" style="width:auto;margin-top:0;padding:5px 10px;font-size:12px;">Disconnect</button>
    </div>
    <fieldset>
      <legend>Synchronization</legend>
      <div class="row"><span class="row-label">Bookmarks</span>
        <label class="switch"><input type="checkbox" id="syncBookmarks" /><span class="track"></span></label>
      </div>
      <div class="row"><span class="row-label">History</span>
        <label class="switch"><input type="checkbox" id="syncHistory" /><span class="track"></span></label>
      </div>
      <div class="row"><span class="row-label">Tabs</span>
        <label class="switch"><input type="checkbox" id="syncTabs" /><span class="track"></span></label>
      </div>
      <div class="row"><span class="row-label">Tab Groups</span>
        <label class="switch"><input type="checkbox" id="syncTabGroups" /><span class="track"></span></label>
      </div>
    </fieldset>
    <fieldset>
      <legend>Tab restore</legend>
      <label class="field">
        <span>Restore remote tabs</span>
        <select id="tabRestorePolicy">
          <option value="disabled">Disabled</option>
          <option value="ask">Ask before restoring</option>
          <option value="automatic">Automatically restore</option>
        </select>
      </label>
    </fieldset>
    <fieldset>
      <legend>History</legend>
      <label class="field">
        <span>Retention</span>
        <select id="historyRetention">
          <option value="7d">7 days</option>
          <option value="30d">30 days</option>
          <option value="90d">90 days</option>
          <option value="1y">1 year</option>
          <option value="unlimited">Unlimited</option>
        </select>
      </label>
    </fieldset>
    <fieldset>
      <legend>Account</legend>
      <div class="row"><span class="row-label">Password</span>
        <a href="#" id="change-password-link">Change on the web</a>
      </div>
    </fieldset>
    <button id="save-settings" class="primary">Save</button>
    <div class="status-message" id="status"></div>
  `;

  // Like Bitwarden's extension, password changes happen on the web
  // dashboard: it holds the account's KDF material and the change form.
  document.getElementById("change-password-link")?.addEventListener("click", (e) => {
    e.preventDefault();
    void chrome.tabs.create({ url: `${new URL(device.serverUrl).origin}/security` });
  });

  document.getElementById("disconnect")?.addEventListener("click", async () => {
    const confirmed = await showConfirmDialog(
      "Disconnect this device? It will be removed from your account's device list, and you can reconnect any time by signing in again."
    );
    if (!confirmed) return;
    const disconnectButton = document.getElementById("disconnect") as HTMLButtonElement | null;
    if (disconnectButton) {
      disconnectButton.disabled = true;
      disconnectButton.textContent = "Disconnecting…";
    }
    // Before the local wipe, which deletes the tokens this call needs. The
    // outcome is deliberately ignored: offline or failed, this device still
    // disconnects locally (and can be revoked from the dashboard instead).
    await revokeThisDevice();
    await clearAllLocalData();
    await invalidateSettingsCache();
    await chrome.runtime.sendMessage({ type: "DEVICE_DISCONNECTED" }).catch(() => {});
    await clearDraft(SETTINGS_DRAFT_KEY);
    connectedView = "status";
    await render();
  });

  const status = document.getElementById("status")!;
  try {
    const settings = await fetchSettings();
    const draft = (await loadDraft<SettingsDraft>(SETTINGS_DRAFT_KEY)) ?? {};
    fillSettingsForm(settings, draft);
  } catch (err) {
    showError(status, `Failed to load settings: ${errorMessage(err)}`);
  }

  const persistSettingsDraft = () => {
    saveDraftDebounced<SettingsDraft>(SETTINGS_DRAFT_KEY, readSettingsForm());
  };
  for (const id of [...SYNC_TOGGLE_IDS, ...SETTINGS_SELECT_IDS]) {
    document.getElementById(id)?.addEventListener("change", persistSettingsDraft);
  }

  document.getElementById("save-settings")?.addEventListener("click", async () => {
    status.classList.remove("error");
    status.textContent = "Saving…";
    const patch: UpdateSettingsRequest = readSettingsForm();
    try {
      await updateSettings(patch);
      await clearDraft(SETTINGS_DRAFT_KEY);
      await chrome.runtime.sendMessage({ type: "REFRESH_CAPTURE_CONFIG" });
      connectedView = "status";
      await render();
    } catch (err) {
      showError(status, `Failed to save: ${errorMessage(err)}`);
    }
  });
}

render().catch((e) => {
  app.innerHTML = `<p class="meta">Failed to load: ${escapeAttr(String(e))}</p>`;
});
