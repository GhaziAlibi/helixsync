import {
  ApiError,
  NetworkError,
  registerDevice,
  prelogin,
  fetchSettings,
  updateSettings,
  invalidateSettingsCache,
  revokeThisDevice,
  serverSupportsRestorePoints,
  serverSupportsSendTab,
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
import { retentionCutoffMs } from "../util/retention";
import { assertSecureServerUrl, InsecureServerUrlError } from "./serverUrl";
import { renderRestorePointsView } from "./restore-points";
import { failureMessage } from "../send-tab/messages";
import type { SendTabResult } from "../send-tab/send";
import { isSyncableUrl } from "../util/url-scheme";
import { platform } from "@platform";
import {
  LANGUAGES,
  LANGUAGE_STORAGE_KEY,
  hasMessage,
  initI18n,
  isSupportedLanguage,
  setUiLanguage,
  t,
  timeAgo,
  tp,
} from "../i18n";

const hostPermissionOrigins = (serverUrl: string): string[] => platform.hostPermissionOrigins(serverUrl);

const app = document.getElementById("app")!;
const headerActions = document.getElementById("header-actions")!;

// The popup is the extension's only UI; "settings" is reached from "status"
// through the header gear.
type ConnectedView = "status" | "settings" | "restorePoints";
let connectedView: ConnectedView = "status";

// Registration happens server-side before the slow key derivation finishes,
// so a double submit (or a click racing the pending-connect resume) would
// create two device rows for one browser.
let connectInFlight = false;

// Chrome destroys the popup whenever it loses focus, so in-progress form
// input is saved to chrome.storage.local as the user types and restored on
// the next open.
const SETUP_DRAFT_KEY = "setupDraft";
// Only the fields the user changed and hasn't saved: a draft of the whole
// form would bring back, and then save, values another device or the
// dashboard has changed since. Drafts under the old key held the whole form,
// so they are dropped.
const SETTINGS_DRAFT_KEY = "settingsDraftChanges";
const LEGACY_SETTINGS_DRAFT_KEY = "settingsDraft";
// SEC-12: the password goes to chrome.storage.session (memory-only, cleared
// when the browser exits), never to chrome.storage.local on disk.
const SETUP_PASSWORD_KEY = "setupDraftPassword";
// A waiting login-with-device request, private key included: also
// chrome.storage.session only, for the same reason.
const DEVICE_LOGIN_KEY = "pendingDeviceLogin";
const DEVICE_LOGIN_POLL_MS = 3000;
// Set when a saved retention change widens the window past what this device
// already imported; cleared when its "Sync older history" button is clicked.
const OLDER_HISTORY_OFFER_KEY = "olderHistoryOffer";

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
// Absent on a server without restore points, so the row is hidden then.
const RESTORE_POINTS_TOGGLE_ID = "restorePointsAutomatic";
// Optional in the manifest: asked for only when tab group sync is turned on.
const TAB_GROUPS_PERMISSION: chrome.permissions.Permissions = { permissions: ["tabGroups"] };
// Optional: lets the extension show a toast when a tab is sent or arrives.
const NOTIFICATIONS_PERMISSION: chrome.permissions.Permissions = { permissions: ["notifications"] };
type SyncToggleId = (typeof SYNC_TOGGLE_IDS)[number];
const SETTINGS_SELECT_IDS = ["tabRestorePolicy", "historyRetention"] as const;

type SettingsForm = Pick<UserSettingsDto, SyncToggleId | "tabRestorePolicy" | "historyRetention" | "restorePointsAutomatic">;
type SettingsDraft = Partial<
  Record<SyncToggleId | "restorePointsAutomatic", boolean> & Record<"tabRestorePolicy" | "historyRetention", string>
>;

async function loadDraft<T>(key: string): Promise<T | undefined> {
  const result = await chrome.storage.local.get(key);
  return result[key] as T | undefined;
}

async function saveDraft<T>(key: string, draft: T): Promise<void> {
  await chrome.storage.local.set({ [key]: draft });
}

/** Offers the older-history import once per retention change, and only when
 * the new window reaches further back than this device has imported (or is
 * importing). Any other change withdraws a previous offer. */
async function updateOlderHistoryOffer(retention: string): Promise<void> {
  const device = await getDevice();
  const covered = [device?.historyBulkCutoffMs, device?.historyOlderCutoffMs].filter(
    (ms): ms is number => ms !== undefined,
  );
  if (covered.length > 0 && retentionCutoffMs(retention) < Math.min(...covered)) {
    await chrome.storage.local.set({ [OLDER_HISTORY_OFFER_KEY]: true });
  } else {
    await chrome.storage.local.remove(OLDER_HISTORY_OFFER_KEY);
  }
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

/** The text for a failure: the translated message for a known server code or a
 * network failure (the same `statusErr_*` strings the sync status uses),
 * otherwise the error's own message. */
function errorMessage(err: unknown): string {
  const code =
    err instanceof ApiError ? (err.status === 429 ? "rate_limited" : err.code) : err instanceof NetworkError ? "network" : undefined;
  if (code && hasMessage(`statusErr_${code}`)) return t(`statusErr_${code}`);
  return err instanceof Error ? err.message : String(err);
}

/** `t`, escaped for use inside an innerHTML template. */
function th(key: string, params?: Record<string, string | number>): string {
  return escapeAttr(t(key, params));
}

/** Like `th`, for a message with a {link} placeholder that becomes `linkHtml`
 * (already escaped markup). */
function thWithLink(key: string, linkHtml: string): string {
  return th(key, { link: "{link}" }).replace("{link}", linkHtml);
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
function showConfirmDialog(message: string, confirmLabel = t("common_disconnect")): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal-card">
        <p>${escapeAttr(message)}</p>
        <div class="modal-actions">
          <button class="ghost" id="modal-cancel">${th("common_cancel")}</button>
          <button class="danger" id="modal-confirm">${escapeAttr(confirmLabel)}</button>
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
const HISTORY_ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M12 7v5l3 2"/></svg>';
const BACK_ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg>';

/** The language picker: "browser default" or one of the languages, each
 * named in itself. */
async function languageFieldHtml(): Promise<string> {
  const stored = (await chrome.storage.local.get(LANGUAGE_STORAGE_KEY))[LANGUAGE_STORAGE_KEY];
  const selected = isSupportedLanguage(stored) ? stored : "";
  const options = [
    `<option value=""${selected === "" ? " selected" : ""}>${th("language_auto")}</option>`,
    ...LANGUAGES.map(
      (l) => `<option value="${l.code}"${selected === l.code ? " selected" : ""}>${escapeAttr(l.name)}</option>`,
    ),
  ];
  return `<label class="field"><span>${th("language_label")}</span><select id="uiLanguage">${options.join("")}</select></label>`;
}

/** `beforeChange` runs first, to save what the user typed: the view is drawn
 * again in the new language. */
function bindLanguageField(beforeChange: () => Promise<void>): void {
  document.getElementById("uiLanguage")?.addEventListener("change", async (e) => {
    const value = (e.currentTarget as HTMLSelectElement).value;
    await beforeChange();
    await setUiLanguage(isSupportedLanguage(value) ? value : null);
    await render();
  });
}

function statusDotClass(status: string): string {
  if (status === "syncing") return "syncing";
  if (status === "error" || status === "needs_reauth") return "error";
  return "synced";
}

function statusLabel(status: string): string {
  switch (status) {
    case "syncing":
      return t("status_syncing");
    case "error":
      return t("status_error");
    case "needs_reauth":
      return t("status_needsReauth");
    default:
      return t("status_synced");
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
    label.textContent = t("pending_header", { count: remainingCount });
    restoreAllButton.textContent = t("pending_restoreAll", { count: remainingCount });
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
    error.textContent = t("pending_failed", { message: errorMessage(err) });
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
    restoreButton.textContent = t("pending_restore");
    restoreButton.addEventListener("click", () => {
      void (async () => {
        restoreButton.disabled = true;
        restoreButton.textContent = t("pending_restoring");
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
          restoreButton.textContent = t("pending_restore");
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
    showMoreButton.textContent = t("pending_showMore", { count: hiddenAtRender });
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
  } else if (connectedView === "restorePoints") {
    renderHeaderButton("back-to-status", t("header_back"), BACK_ICON, "status");
    await renderRestorePointsView(app, { rerender: render, confirm: showConfirmDialog });
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

  const languageField = await languageFieldHtml();
  app.innerHTML = `
    <h2 class="view-title">${th("setup_title")}</h2>
    <p class="view-subtitle">${th("setup_subtitle")}</p>
    <form id="setup-form">
      <label class="field">
        <span>${th("setup_serverUrl")}</span>
        <input type="text" id="serverUrl" placeholder="https://sync.example.com" value="${escapeAttr(draft.serverUrl ?? "")}" required />
      </label>
      <label class="field">
        <span>${th("setup_email")}</span>
        <input type="email" id="email" value="${escapeAttr(draft.email ?? "")}" required />
      </label>
      <label class="field">
        <span>${th("setup_password")}</span>
        <input type="password" id="password" value="${escapeAttr(password)}" required />
      </label>
      <label class="field">
        <span>${th("setup_deviceName")}</span>
        <input type="text" id="deviceName" value="${escapeAttr(draft.deviceName ?? defaultDeviceName())}" required />
      </label>
      <button type="submit" class="primary">${th("setup_connect")}</button>
      <button type="button" id="device-login" class="ghost">${th("setup_deviceLoginInstead")}</button>
    </form>
    <div class="status-message" id="status"></div>
    <p class="view-subtitle">
      ${thWithLink("setup_noAccount", `<a href="#" id="register-link">${th("setup_registerLink")}</a>`)}
    </p>
    <p class="view-subtitle">
      <a href="#" id="forgot-password-link">${th("setup_forgotLink")}</a>
    </p>
    ${languageField}
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
      showError(status, t("setup_serverUrlFirst"));
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
  bindLanguageField(async () => {
    await saveDraft<SetupDraft>(SETUP_DRAFT_KEY, {
      serverUrl: inputById("serverUrl").value,
      email: inputById("email").value,
      deviceName: inputById("deviceName").value,
    });
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
        showError(status, err instanceof InsecureServerUrlError ? t("setup_insecureUrl") : t("setup_serverUrlInvalid"));
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
        showError(status, t("setup_permissionDenied"));
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
      showError(status, t("setup_emailAndName"));
      return;
    }
    let origins: string[];
    try {
      assertSecureServerUrl(serverUrl);
      origins = hostPermissionOrigins(serverUrl);
    } catch (err) {
      showError(status, err instanceof InsecureServerUrlError ? t("setup_insecureUrl") : t("setup_serverUrlInvalid"));
      return;
    }

    // Same gesture rule as Connect: no await before the permission request.
    void saveDraft<SetupDraft>(SETUP_DRAFT_KEY, { serverUrl, email, deviceName, pendingDeviceLogin: true });
    const granted = await chrome.permissions.request({ origins });
    if (!granted) {
      await saveDraft<SetupDraft>(SETUP_DRAFT_KEY, { serverUrl, email, deviceName, pendingDeviceLogin: false });
      showError(status, t("setup_permissionDenied"));
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
    showError(status, t("setup_permissionLastDevice"));
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
  status.textContent = t("setup_creatingRequest");
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
    showError(status, t("setup_failed", { message: errorMessage(err) }));
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
    <h2 class="view-title">${th("devicewait_title")}</h2>
    <p class="view-subtitle">${th("devicewait_body")}</p>
    <div class="fingerprint" id="fingerprint"></div>
    <div class="status-message" id="status">${th("devicewait_waiting")}</div>
    <button id="cancel-device-login" class="ghost">${th("common_cancel")}</button>
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
          onMismatch: () => abandonDeviceLogin(t("devicewait_keyMismatch")),
        });
        return;
      }
      if (result.status === "denied") {
        await abandonDeviceLogin(t("devicewait_denied"));
        return;
      }
      if (result.status === "expired") {
        await abandonDeviceLogin(t("devicewait_expired"));
        return;
      }
    } catch (err) {
      // The approval stays collectable until the request expires, so the
      // device cap and transient failures just show and keep waiting.
      status.classList.add("error");
      status.textContent =
        err instanceof ApiError && err.code === "device_limit_reached"
          ? t("devicewait_deviceLimit")
          : t("devicewait_stillWaiting", { message: errorMessage(err) });
    }
    if (Date.now() >= Date.parse(pending.expiresAt)) {
      await abandonDeviceLogin(t("devicewait_expired"));
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
    <h2 class="view-title">${th("keycheck_title")}</h2>
    <p class="view-subtitle">${th("keycheck_body")}</p>
    <div class="fingerprint" id="key-check"></div>
    <div class="status-message" id="status"></div>
    <button id="key-check-match" class="primary">${th("keycheck_matches")}</button>
    <button id="key-check-mismatch">${th("keycheck_mismatch")}</button>
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
      showError(status, t("setup_insecureUrl"));
    }
    return;
  }

  const alreadyGranted = await chrome.permissions.contains({ origins });
  if (!alreadyGranted) {
    await saveDraft<SetupDraft>(SETUP_DRAFT_KEY, { ...draft, pendingConnect: false });
    showError(status, t("setup_permissionLastConnect"));
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
  status.textContent = t("setup_connecting");

  try {
    await ensureCryptoReady();

    // SEC-01 / docs/encryption.md §2: the password never leaves the device.
    // It derives the authKey (sent in place of the password) and the KEK
    // (unwraps the account key, never sent).
    status.textContent = t("setup_deriving");
    const { kdfSalt, kdfParams } = await prelogin(serverUrl, email);
    const masterKey = await deriveMasterKey(password, kdfSalt, kdfParams);
    const authKey = await deriveAuthKey(masterKey);
    const kek = await deriveKek(masterKey);

    status.textContent = t("setup_connecting");
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
    showError(status, t("setup_failed", { message: errorMessage(err) }));
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
  renderHeaderButtons([{ id, title, icon, targetView }]);
}

function renderHeaderButtons(buttons: Array<{ id: string; title: string; icon: string; targetView: ConnectedView }>): void {
  headerActions.innerHTML = buttons
    .map(({ id, title, icon }) => `<button class="icon-button" id="${id}" title="${escapeAttr(title)}">${icon}</button>`)
    .join("");
  for (const { id, targetView } of buttons) {
    document.getElementById(id)?.addEventListener("click", async () => {
      connectedView = targetView;
      await render();
    });
  }
}

async function renderStatusView(device: DeviceRecord): Promise<void> {
  renderHeaderButton("open-settings", t("header_settings"), GEAR_ICON, "settings");

  const [response, settings, authRequests, restorePointsSupported, sendTabSupported] = await Promise.all([
    chrome.runtime.sendMessage({ type: "GET_STATUS" }),
    fetchSettings().catch(() => undefined),
    listAuthRequests().catch((): PendingAuthRequest[] => []),
    serverSupportsRestorePoints().catch(() => false),
    serverSupportsSendTab().catch(() => false),
  ]);

  // Restore points need bookmark sync, a finished first import and a server
  // that has them; without those the button isn't shown at all.
  if (
    device.initialImportCompletedAt &&
    settings?.syncBookmarks !== false &&
    restorePointsSupported
  ) {
    renderHeaderButtons([
      { id: "open-restore-points", title: t("header_restorePoints"), icon: HISTORY_ICON, targetView: "restorePoints" },
      { id: "open-settings", title: t("header_settings"), icon: GEAR_ICON, targetView: "settings" },
    ]);
  }

  app.innerHTML = `
    <div class="status-card">
      <span class="dot ${statusDotClass(response.status)}"></span>
      <div class="status-text">
        <strong>${statusLabel(response.status)}</strong>
        <span>${escapeAttr(t("statusview_lastSync", { time: timeAgo(response.lastSyncAt), pending: response.pendingCount ?? 0 }))}</span>
      </div>
    </div>
    <button id="sync-now" class="primary">${th("statusview_syncNow")}</button>
  `;

  // The detail is an error message that can echo server text, so it's set
  // as textContent, never markup.
  if ((response.status === "error" || response.status === "needs_reauth") && response.errorDetail) {
    const detail = document.createElement("div");
    detail.className = "status-message error";
    const codeKey = `statusErr_${response.errorCode}`;
    detail.textContent = response.errorCode && hasMessage(codeKey) ? t(codeKey) : response.errorDetail;
    document.querySelector(".status-card")!.insertAdjacentElement("afterend", detail);
  }

  if ((await chrome.storage.local.get(OLDER_HISTORY_OFFER_KEY))[OLDER_HISTORY_OFFER_KEY]) {
    const olderHistory = document.createElement("button");
    olderHistory.id = "sync-older-history";
    olderHistory.textContent = t("statusview_olderHistory");
    olderHistory.title = t("statusview_olderHistoryTitle");
    document.getElementById("sync-now")!.insertAdjacentElement("afterend", olderHistory);
    olderHistory.addEventListener("click", async () => {
      olderHistory.remove();
      await chrome.storage.local.remove(OLDER_HISTORY_OFFER_KEY);
      const message = document.createElement("div");
      message.className = "status-message";
      document.getElementById("sync-now")!.insertAdjacentElement("afterend", message);
      try {
        const result = await chrome.runtime.sendMessage({ type: "IMPORT_OLDER_HISTORY" });
        if (!result?.ok) throw new Error(result?.error ?? t("statusview_importRequestFailed"));
        message.textContent = t("statusview_importStarted");
      } catch (err) {
        showError(message, t("statusview_importFailed", { message: errorMessage(err) }));
      }
    });
  }

  if (authRequests.length > 0) {
    document
      .getElementById("sync-now")!
      .insertAdjacentElement("beforebegin", await renderAuthRequests(device, authRequests));
  }

  document.getElementById("sync-now")?.addEventListener("click", async (e) => {
    const button = e.currentTarget as HTMLButtonElement;
    button.disabled = true;
    button.textContent = t("status_syncing");
    try {
      await chrome.runtime.sendMessage({ type: "SYNC_NOW" });
    } finally {
      await render();
    }
  });

  if (sendTabSupported) app.appendChild(renderSendTabSection());

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
          throw new Error(response?.error ?? t("statusview_restoreRequestFailed"));
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
  footer.textContent = t("statusview_signedInAs", { email: device.email });
  app.appendChild(footer);
}

interface SendTarget {
  id: string;
  name: string;
  online?: boolean;
}

/** "Send this tab to" picker (docs/protocol.md §12.5): the other devices with
 * their live online state. Built with DOM APIs: device names are free text.
 * Asking the worker for the list also refreshes its context menu. */
function renderSendTabSection(): HTMLElement {
  const section = document.createElement("div");
  const label = document.createElement("div");
  label.className = "section-label";
  label.textContent = t("sendtab_label");
  const list = document.createElement("div");
  list.textContent = t("common_loading");
  list.className = "item-meta";
  const message = document.createElement("div");
  message.className = "status-message";
  section.append(label, list, message);

  void (async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const response = await chrome.runtime.sendMessage({ type: "LIST_SEND_TARGETS" });
      if (!response?.ok) throw new Error(response?.error ?? t("sendtab_listFailed"));
      const devices = response.devices as SendTarget[];
      list.textContent = "";
      list.className = "";
      if (devices.length === 0) {
        list.className = "item-meta";
        list.textContent = t("sendtab_noDevices");
        return;
      }
      const sendable = !!tab?.url && isSyncableUrl(tab.url);
      if (!sendable) {
        message.textContent = t("sendtab_badUrl");
      }
      for (const device of devices) {
        const button = document.createElement("button");
        button.disabled = !sendable;
        const name = document.createElement("span");
        name.textContent = device.name;
        const state = document.createElement("span");
        state.className = "item-meta";
        state.textContent = ` · ${device.online ? t("sendtab_online") : t("sendtab_offlineState")}`;
        button.append(name, state);
        button.addEventListener("click", async () => {
          button.disabled = true;
          message.classList.remove("error");
          message.textContent = "";
          try {
            const result = (await chrome.runtime.sendMessage({
              type: "SEND_TAB",
              deviceId: device.id,
              url: tab.url,
              title: tab.title,
            })) as SendTabResult | undefined;
            if (result?.ok) message.textContent = t("sendtab_sent", { device: device.name });
            else
              showError(
                message,
                result ? failureMessage(t, result, device.name) : t("sendtab_failed", { message: t("statusview_restoreRequestFailed") }),
              );
          } catch (err) {
            showError(message, t("sendtab_failed", { message: errorMessage(err) }));
          } finally {
            button.disabled = false;
          }
        });
        list.appendChild(button);
      }
    } catch (err) {
      list.textContent = "";
      showError(message, t("sendtab_failed", { message: errorMessage(err) }));
    }
  })();
  return section;
}

/** Sign-in requests waiting for this account's approval (login with device,
 * docs/protocol.md §7.4). Built with DOM APIs, not innerHTML: the device
 * name and user agent come from whoever made the request. */
async function renderAuthRequests(device: DeviceRecord, requests: PendingAuthRequest[]): Promise<HTMLElement> {
  const section = document.createElement("div");
  const label = document.createElement("div");
  label.className = "section-label";
  label.textContent = tp("auth_requests", requests.length);
  section.appendChild(label);

  for (const request of requests) {
    const card = document.createElement("div");
    card.className = "auth-request";

    const title = document.createElement("div");
    title.className = "item-title";
    const isReset = request.kind === "reset";
    // The first of the two approvals carries no key; the second hands over
    // the account key.
    const completesReset = isReset && (request.approvals ?? 0) >= 1;
    title.textContent = isReset
      ? t("auth_passwordReset")
      : request.kind === "web"
        ? t("auth_webSignIn")
        : t("auth_newBrowser", { name: request.deviceName ?? t("auth_unnamed") });
    if (isReset) card.classList.add("password-reset");

    const meta = document.createElement("div");
    meta.className = "item-meta";
    meta.textContent = `${request.requestIp ?? t("auth_unknownIp")} · ${timeAgo(request.createdAt)}`;
    if (request.userAgent) meta.title = request.userAgent;

    const consequence = document.createElement("div");
    consequence.className = "item-meta";
    consequence.textContent = isReset
      ? t(completesReset ? "auth_resetWarningCompletes" : "auth_resetWarningSecond", { approvals: request.approvals ?? 0 })
      : request.kind === "web"
        ? t("auth_webConsequence")
        : t("auth_deviceConsequence");
    if (isReset) consequence.style.fontWeight = "600";

    const prompt = document.createElement("div");
    prompt.className = "item-meta";
    prompt.textContent = t("auth_approveOnlyIf");

    const fingerprint = document.createElement("div");
    fingerprint.className = "fingerprint";
    fingerprint.textContent = await authRequestFingerprint(request.publicKey);

    const keyCheckParts: HTMLElement[] = [];
    if (request.kind === "device" || completesReset) {
      const keyCheckLabel = document.createElement("div");
      keyCheckLabel.className = "item-meta";
      keyCheckLabel.textContent = isReset ? t("auth_keyCheckReset") : t("auth_keyCheckDevice");
      const keyCheck = document.createElement("div");
      keyCheck.className = "fingerprint";
      keyCheck.textContent = await accountKeyCheckPhrase(fromB64(device.accountKey));
      keyCheckParts.push(keyCheckLabel, keyCheck);
    }

    const actions = document.createElement("div");
    actions.className = "auth-actions";
    const approve = document.createElement("button");
    approve.className = "primary";
    approve.textContent = t("auth_approve");
    const deny = document.createElement("button");
    deny.textContent = t("auth_deny");
    actions.append(approve, deny);

    const error = document.createElement("div");
    error.className = "status-message error";

    const answer = async (approved: boolean) => {
      approve.disabled = true;
      deny.disabled = true;
      error.textContent = "";
      try {
        if (approved && (request.kind === "device" || completesReset)) {
          const keys = await encryptAccountKeyForRequest(device.accountKey, request.publicKey, request.id);
          await respondAuthRequest(request.id, { approve: true, ...keys });
        } else {
          await respondAuthRequest(request.id, { approve: approved });
        }
        await render();
      } catch (err) {
        error.textContent =
          err instanceof ApiError && err.status === 404
            ? t("auth_alreadyAnswered")
            : err instanceof ApiError && (err.status === 409 || err.status === 422) && isReset
              ? t("auth_resetChanged")
              : t("auth_failed", { message: errorMessage(err) });
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

function changedSettings(loaded: SettingsForm, form: SettingsForm): UpdateSettingsRequest {
  return Object.fromEntries(
    (Object.keys(form) as Array<keyof SettingsForm>)
      .filter((key) => form[key] !== loaded[key])
      .map((key) => [key, form[key]]),
  );
}

function readSettingsForm(): SettingsForm {
  return {
    syncBookmarks: inputById("syncBookmarks").checked,
    syncHistory: inputById("syncHistory").checked,
    syncTabs: inputById("syncTabs").checked,
    syncTabGroups: inputById("syncTabGroups").checked,
    tabRestorePolicy: selectById("tabRestorePolicy").value as SettingsForm["tabRestorePolicy"],
    historyRetention: selectById("historyRetention").value as SettingsForm["historyRetention"],
    ...(document.getElementById("restore-points-row")?.hidden === false
      ? { restorePointsAutomatic: inputById(RESTORE_POINTS_TOGGLE_ID).checked }
      : {}),
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
  const row = document.getElementById("restore-points-row");
  if (row && settings.restorePointsAutomatic !== undefined) {
    row.hidden = false;
    inputById(RESTORE_POINTS_TOGGLE_ID).checked = draft.restorePointsAutomatic ?? settings.restorePointsAutomatic;
  }
}

/** Not a server setting: the permission is per browser and applies at once,
 * so the toggle asks the browser itself rather than waiting for Save. */
async function bindSendTabNotifications(status: HTMLElement): Promise<void> {
  const fieldset = document.getElementById("send-tab-settings");
  const toggle = document.getElementById("sendTabNotifications") as HTMLInputElement | null;
  if (!fieldset || !toggle) return;
  if (!(await serverSupportsSendTab().catch(() => false)) || !chrome.notifications) return;
  toggle.checked = await chrome.permissions.contains(NOTIFICATIONS_PERMISSION);
  fieldset.hidden = false;
  toggle.addEventListener("change", async () => {
    try {
      if (toggle.checked) {
        // Must be the first await: the request needs the click's user gesture.
        if (!(await chrome.permissions.request(NOTIFICATIONS_PERMISSION))) {
          toggle.checked = false;
          showError(status, t("settings_sendTabDenied"));
        }
      } else {
        await chrome.permissions.remove(NOTIFICATIONS_PERMISSION);
      }
    } catch (err) {
      toggle.checked = await chrome.permissions.contains(NOTIFICATIONS_PERMISSION).catch(() => false);
      showError(status, errorMessage(err));
    }
  });
}

async function renderSettings(device: DeviceRecord): Promise<void> {
  renderHeaderButton("back-to-status", t("header_back"), BACK_ICON, "status");

  const languageField = await languageFieldHtml();
  app.innerHTML = `
    <div class="account-row">
      <span class="email">${escapeAttr(device.email)}</span>
      <button id="disconnect" class="danger" style="width:auto;margin-top:0;padding:5px 10px;font-size:12px;">${th("common_disconnect")}</button>
    </div>
    <fieldset>
      <legend>${th("settings_sync")}</legend>
      <div class="row"><span class="row-label">${th("settings_bookmarks")}</span>
        <label class="switch"><input type="checkbox" id="syncBookmarks" /><span class="track"></span></label>
      </div>
      <div class="row"><span class="row-label">${th("settings_history")}</span>
        <label class="switch"><input type="checkbox" id="syncHistory" /><span class="track"></span></label>
      </div>
      <div class="row"><span class="row-label">${th("settings_tabs")}</span>
        <label class="switch"><input type="checkbox" id="syncTabs" /><span class="track"></span></label>
      </div>
      <div class="row"><span class="row-label">${th("settings_tabGroups")}</span>
        <label class="switch"><input type="checkbox" id="syncTabGroups" /><span class="track"></span></label>
      </div>
    </fieldset>
    <fieldset>
      <legend>${th("settings_tabRestore")}</legend>
      <label class="field">
        <span>${th("settings_restoreRemoteTabs")}</span>
        <select id="tabRestorePolicy">
          <option value="disabled">${th("settings_policyDisabled")}</option>
          <option value="ask">${th("settings_policyAsk")}</option>
          <option value="automatic">${th("settings_policyAutomatic")}</option>
        </select>
      </label>
    </fieldset>
    <fieldset>
      <legend>${th("settings_historyLegend")}</legend>
      <label class="field">
        <span>${th("settings_retention")}</span>
        <select id="historyRetention">
          <option value="7d">${th("settings_d7")}</option>
          <option value="30d">${th("settings_d30")}</option>
          <option value="90d">${th("settings_d90")}</option>
          <option value="1y">${th("settings_y1")}</option>
          <option value="unlimited">${th("settings_unlimited")}</option>
        </select>
      </label>
    </fieldset>
    <fieldset>
      <legend>${th("settings_restorePointsLegend")}</legend>
      <div class="row" id="restore-points-row" hidden><span class="row-label">${th("settings_autoRestorePoints")}</span>
        <label class="switch"><input type="checkbox" id="restorePointsAutomatic" /><span class="track"></span></label>
      </div>
      <div class="item-meta">${th("settings_restorePointsHelp")}</div>
    </fieldset>
    <fieldset id="send-tab-settings" hidden>
      <legend>${th("settings_sendTabLegend")}</legend>
      <div class="row"><span class="row-label">${th("settings_sendTabNotifications")}</span>
        <label class="switch"><input type="checkbox" id="sendTabNotifications" /><span class="track"></span></label>
      </div>
      <div class="item-meta">${th("settings_sendTabHelp")}</div>
    </fieldset>
    <fieldset>
      <legend>${th("language_legend")}</legend>
      ${languageField}
    </fieldset>
    <fieldset>
      <legend>${th("settings_account")}</legend>
      <div class="row"><span class="row-label">${th("settings_password")}</span>
        <a href="#" id="change-password-link">${th("settings_changeOnWeb")}</a>
      </div>
    </fieldset>
    <button id="save-settings" class="primary" disabled>${th("settings_save")}</button>
    <div class="status-message" id="status"></div>
  `;

  // Like Bitwarden's extension, password changes happen on the web
  // dashboard: it holds the account's KDF material and the change form.
  document.getElementById("change-password-link")?.addEventListener("click", (e) => {
    e.preventDefault();
    void chrome.tabs.create({ url: `${new URL(device.serverUrl).origin}/security` });
  });

  document.getElementById("disconnect")?.addEventListener("click", async () => {
    const confirmed = await showConfirmDialog(t("settings_disconnectConfirm"));
    if (!confirmed) return;
    const disconnectButton = document.getElementById("disconnect") as HTMLButtonElement | null;
    if (disconnectButton) {
      disconnectButton.disabled = true;
      disconnectButton.textContent = t("settings_disconnecting");
    }
    // Before the local wipe, which deletes the tokens this call needs. The
    // outcome is deliberately ignored: offline or failed, this device still
    // disconnects locally (and can be revoked from the dashboard instead).
    await revokeThisDevice();
    await clearAllLocalData();
    await invalidateSettingsCache();
    await chrome.runtime.sendMessage({ type: "DEVICE_DISCONNECTED" }).catch(() => {});
    await clearDraft(SETTINGS_DRAFT_KEY);
    await clearDraft(LEGACY_SETTINGS_DRAFT_KEY);
    await chrome.storage.local.remove(OLDER_HISTORY_OFFER_KEY);
    connectedView = "status";
    await render();
  });

  const status = document.getElementById("status")!;
  const saveButton = document.getElementById("save-settings") as HTMLButtonElement;
  void bindSendTabNotifications(status);
  // What the form was filled from; Save sends only fields changed since. Save
  // stays disabled until then: the unfilled form reads as everything off.
  let loaded: SettingsForm | undefined;
  // Bound before the settings load, so the language can change at once; the
  // form is kept only once it holds the server's settings.
  bindLanguageField(async () => {
    if (loaded) await saveDraft<SettingsDraft>(SETTINGS_DRAFT_KEY, changedSettings(loaded, readSettingsForm()));
  });
  try {
    const settings = await fetchSettings({ fresh: true });
    void clearDraft(LEGACY_SETTINGS_DRAFT_KEY);
    const draft = (await loadDraft<SettingsDraft>(SETTINGS_DRAFT_KEY)) ?? {};
    fillSettingsForm(settings, draft);
    loaded = settings;
    saveButton.disabled = false;
    // The setting is account-wide (it can be turned on from the dashboard or
    // another browser), but each browser grants the permission itself.
    if (inputById("syncTabGroups").checked && !(await chrome.permissions.contains(TAB_GROUPS_PERMISSION))) {
      status.textContent = t("settings_tabGroupsNeedPermission");
    }
  } catch (err) {
    showError(status, t("settings_loadFailed", { message: errorMessage(err) }));
  }

  const persistSettingsDraft = () => {
    if (loaded) saveDraftDebounced<SettingsDraft>(SETTINGS_DRAFT_KEY, changedSettings(loaded, readSettingsForm()));
  };
  for (const id of [...SYNC_TOGGLE_IDS, ...SETTINGS_SELECT_IDS, RESTORE_POINTS_TOGGLE_ID]) {
    document.getElementById(id)?.addEventListener("change", persistSettingsDraft);
  }
  saveButton.addEventListener("click", async () => {
    if (!loaded) return;
    status.classList.remove("error");
    status.textContent = t("settings_saving");
    const form = readSettingsForm();
    // Settings are account-wide: sending only what changed here keeps a
    // change made meanwhile on another device or the dashboard.
    const patch: UpdateSettingsRequest = changedSettings(loaded, form);
    // Requested before any await: chrome.permissions.request() must run inside
    // the click's user gesture. Resolves at once when already granted.
    const tabGroupsGranted = form.syncTabGroups ? chrome.permissions.request(TAB_GROUPS_PERMISSION) : Promise.resolve(true);
    try {
      if (!(await tabGroupsGranted)) {
        showError(status, t("settings_tabGroupsDenied"));
        return;
      }
      await updateSettings(patch);
      await clearDraft(SETTINGS_DRAFT_KEY);
      if (patch.historyRetention !== undefined) await updateOlderHistoryOffer(patch.historyRetention);
      await chrome.runtime.sendMessage({ type: "REFRESH_CAPTURE_CONFIG" });
      connectedView = "status";
      await render();
    } catch (err) {
      showError(status, t("settings_saveFailed", { message: errorMessage(err) }));
    }
  });
}

initI18n()
  .catch((e) => console.error("HelixSync: could not load the interface language", e))
  .then(() => render())
  .catch((e) => {
    app.innerHTML = `<p class="meta">${th("app_loadFailed", { message: String(e) })}</p>`;
  });
