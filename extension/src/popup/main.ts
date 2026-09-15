import {
  registerDevice,
  fetchSettings,
  updateSettings,
  invalidateSettingsCache,
  type UpdateSettingsRequest,
} from "../api/client";
import {
  clearDevice,
  getDevice,
  getPendingTabRestores,
  getSyncedHistoryVisits,
  putDevice,
  type DeviceRecord,
} from "../storage/db";
import type { PendingTabRestore } from "../storage/selectors";
import type { HistoryVisitPayload } from "../sync/types";
import { ensureCryptoReady, deriveRekFromPassword } from "../crypto";

/** Both the exact https origin (for ordinary REST calls) and its wss
 * counterpart (for the WebSocket push-notification channel,
 * extension/src/api/websocket.ts — docs/protocol.md §12) fall under the
 * wildcard-scheme optional host permission declared in manifest.json, so
 * both can be requested/checked together in one call — prompting the user
 * once for both instead of a second surprise prompt the first time the
 * WebSocket module tries to connect. */
function hostPermissionOrigins(serverUrl: string): string[] {
  const url = new URL(serverUrl);
  const wsScheme = url.protocol === "https:" ? "wss:" : "ws:";
  return [`${url.origin}/*`, `${wsScheme}//${url.host}/*`];
}

const app = document.getElementById("app")!;
const headerActions = document.getElementById("header-actions")!;

// The popup is the extension's only UI — there is no separate options tab
// (manifest.json has no `options_page`). "settings" is reached from
// "status" via the header's gear icon and never navigated to directly.
type ConnectedView = "status" | "settings";
let connectedView: ConnectedView = "status";

// The popup document is destroyed — not just hidden — every time it loses
// focus (clicking away, alt-tabbing, a password manager opening its own
// popup to autofill). That's normal, frequent behavior, not an error case,
// but it means anything held only in the DOM or JS variables is gone the
// next time the user opens the popup. chrome.storage.local survives across
// that (unlike sessionStorage, which is tied to the now-destroyed
// document), so in-progress form input is saved there as the user types
// and restored on the next open — cleared only once it's actually been
// used successfully (connected / saved).
const SETUP_DRAFT_KEY = "setupDraft";
const SETTINGS_DRAFT_KEY = "settingsDraft";

interface SetupDraft {
  serverUrl?: string;
  email?: string;
  password?: string;
  deviceName?: string;
  // Set right before requesting the origin permission and cleared once the
  // attempt resolves. chrome.permissions.request's native dialog steals
  // focus and Chrome destroys this popup as a result (see the comment
  // above SETUP_DRAFT_KEY), killing the in-flight connect attempt along
  // with it. This flag lets the next popup open detect that and resume
  // automatically instead of leaving the user stuck re-clicking Connect.
  pendingConnect?: boolean;
}

interface SettingsDraft {
  syncBookmarks?: boolean;
  syncHistory?: boolean;
  syncTabs?: boolean;
  syncTabGroups?: boolean;
  tabRestorePolicy?: string;
  historyRetention?: string;
}

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

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// window.confirm() renders outside the popup's own layout and doesn't respect
// its fixed width, so its buttons can end up clipped outside the popup's
// visible/clickable area. This renders the confirmation inside our own DOM
// instead, constrained by the popup's CSS like everything else.
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

    const cleanup = (result: boolean) => {
      overlay.remove();
      resolve(result);
    };
    overlay.querySelector("#modal-cancel")!.addEventListener("click", () => cleanup(false));
    overlay.querySelector("#modal-confirm")!.addEventListener("click", () => cleanup(true));
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

/** Renders the "Synced history from other devices" list using DOM APIs
 * (not innerHTML) so remote-supplied title/url strings are always treated
 * as text, never markup — this is the only place in the popup that
 * displays another device's synced content. See README.md "Known gaps":
 * chrome.history.addUrl can't set a historical timestamp or title, so this
 * list is how the real title/url/visitedAt stay visible. */
function renderHistoryList(visits: HistoryVisitPayload[]): HTMLElement | null {
  if (visits.length === 0) return null;

  const section = document.createElement("div");
  const label = document.createElement("div");
  label.className = "section-label";
  label.textContent = "Synced history from other devices";
  section.appendChild(label);

  const list = document.createElement("ul");
  list.className = "item-list";
  for (const visit of visits.slice(0, 5)) {
    const item = document.createElement("li");
    item.className = "item";

    const title = document.createElement("div");
    title.className = "item-title";
    title.textContent = visit.title || visit.url;
    title.title = visit.url;

    const meta = document.createElement("div");
    meta.className = "item-meta";
    meta.textContent = timeAgo(visit.visitedAt);

    item.append(title, meta);
    list.appendChild(item);
  }
  section.appendChild(list);
  return section;
}

// A device that synced 150+ open tabs would otherwise force
// renderPendingTabRestores to build 150+ <li> nodes (and click handlers)
// just to open the popup — visible jank on every open. Cap the initial
// render and reveal the rest only on demand via "Show more", same
// motivation as renderHistoryList's `.slice(0, 5)` cap above, just a
// higher limit since these rows (title + one button) are cheaper than
// history rows and users are more likely to want to see most of them.
const PENDING_RESTORE_PAGE_SIZE = 15;

/** Renders the "ask" restore-policy list: remote tabs tracked but not yet
 * materialized locally, each with a "Restore" button, plus a "Restore all"
 * button. Uses DOM APIs (not innerHTML) for the same remote-content-is-not-
 * markup reason as `renderHistoryList`. */
function renderPendingTabRestores(
  pending: PendingTabRestore[],
  onRestore: (objectId: string) => Promise<void>,
  onRestoreAll: () => void,
): HTMLElement | null {
  if (pending.length === 0) return null;

  const section = document.createElement("div");
  const label = document.createElement("div");
  label.className = "section-label";
  const restoreAllButton = document.createElement("button");
  let remainingCount = pending.length;
  const updateCount = () => {
    label.textContent = `Tabs from other devices (${remainingCount})`;
    restoreAllButton.textContent = `Restore all (${remainingCount})`;
  };
  updateCount();
  section.appendChild(label);

  const list = document.createElement("ul");
  list.className = "item-list";

  const appendItem = ({ objectId, payload }: PendingTabRestore) => {
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
          // Keep the row in place when the background worker rejected the
          // restore. A full popup render used to do this incidentally, but it
          // also reloaded every unrelated status/settings/history section.
          restoreButton.disabled = false;
          restoreButton.textContent = "Restore";
          let error = section.querySelector<HTMLElement>(".restore-error");
          if (!error) {
            error = document.createElement("div");
            error.className = "status-message error restore-error";
            section.appendChild(error);
          }
          error.textContent = `Failed to restore tab: ${err instanceof Error ? err.message : String(err)}`;
        }
      })();
    });

    item.append(info, restoreButton);
    list.appendChild(item);
  };

  for (const entry of pending.slice(0, PENDING_RESTORE_PAGE_SIZE)) {
    appendItem(entry);
  }
  section.appendChild(list);

  if (pending.length > PENDING_RESTORE_PAGE_SIZE) {
    const remaining = pending.slice(PENDING_RESTORE_PAGE_SIZE);
    const showMoreButton = document.createElement("button");
    showMoreButton.className = "ghost";
    showMoreButton.textContent = `Show ${remaining.length} more`;
    showMoreButton.addEventListener("click", () => {
      for (const entry of remaining) appendItem(entry);
      showMoreButton.remove();
    });
    section.appendChild(showMoreButton);
  }

  // Assigned by updateCount above; kept as a separate element so a single
  // successful restore can update its count without rerendering the popup.
  updateCount();
  restoreAllButton.addEventListener("click", onRestoreAll);
  section.appendChild(restoreAllButton);

  return section;
}

async function render(): Promise<void> {
  const device = await getDevice();
  if (!device) {
    headerActions.innerHTML = "";
    await renderSetup();
    return;
  }
  if (connectedView === "settings") {
    await renderSettings(device);
  } else {
    await renderStatusView(device);
  }
}

async function renderSetup(): Promise<void> {
  const draft = (await loadDraft<SetupDraft>(SETUP_DRAFT_KEY)) ?? {};

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
        <input type="password" id="password" value="${escapeAttr(draft.password ?? "")}" required />
      </label>
      <label class="field">
        <span>Device name</span>
        <input type="text" id="deviceName" value="${escapeAttr(draft.deviceName ?? defaultDeviceName())}" required />
      </label>
      <button type="submit" class="primary">Connect</button>
    </form>
    <p class="view-subtitle">
      Don't have an account? <a href="#" id="register-link">Register on the web</a>
    </p>
    <div class="status-message" id="status"></div>
  `;

  const form = document.getElementById("setup-form") as HTMLFormElement;
  const status = document.getElementById("status")!;

  document.getElementById("register-link")?.addEventListener("click", (e) => {
    e.preventDefault();
    const serverUrl = (document.getElementById("serverUrl") as HTMLInputElement).value.trim();
    status.classList.remove("error");

    let origin: string;
    try {
      origin = new URL(serverUrl).origin;
    } catch {
      status.classList.add("error");
      status.textContent = "Enter a valid Server URL first.";
      return;
    }

    void chrome.tabs.create({ url: `${origin}/login?mode=register` });
  });

  const persistDraft = () => {
    void saveDraft<SetupDraft>(SETUP_DRAFT_KEY, {
      serverUrl: (document.getElementById("serverUrl") as HTMLInputElement).value,
      email: (document.getElementById("email") as HTMLInputElement).value,
      password: (document.getElementById("password") as HTMLInputElement).value,
      deviceName: (document.getElementById("deviceName") as HTMLInputElement).value,
    });
  };
  for (const id of ["serverUrl", "email", "password", "deviceName"]) {
    document.getElementById(id)?.addEventListener("input", persistDraft);
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const serverUrl = (document.getElementById("serverUrl") as HTMLInputElement).value.replace(/\/$/, "");
    const email = (document.getElementById("email") as HTMLInputElement).value;
    const password = (document.getElementById("password") as HTMLInputElement).value;
    const deviceName = (document.getElementById("deviceName") as HTMLInputElement).value;

    await saveDraft<SetupDraft>(SETUP_DRAFT_KEY, { serverUrl, email, password, deviceName, pendingConnect: true });
    await attemptConnect({ serverUrl, email, password, deviceName }, status);
  });

  // A previous Connect click may have been interrupted mid-flow by the
  // permissions dialog killing this popup (see pendingConnect's doc
  // comment). If the permission ended up granted anyway, finish the
  // attempt now instead of making the user fill in the form and click
  // Connect again.
  if (draft.pendingConnect && draft.serverUrl && draft.email && draft.password) {
    let origins: string[];
    try {
      origins = hostPermissionOrigins(draft.serverUrl);
    } catch {
      await saveDraft<SetupDraft>(SETUP_DRAFT_KEY, { ...draft, pendingConnect: false });
      return;
    }

    const alreadyGranted = await chrome.permissions.contains({ origins });
    if (alreadyGranted) {
      await attemptConnect(
        {
          serverUrl: draft.serverUrl,
          email: draft.email,
          password: draft.password,
          deviceName: draft.deviceName ?? defaultDeviceName(),
        },
        status,
      );
    } else {
      await saveDraft<SetupDraft>(SETUP_DRAFT_KEY, { ...draft, pendingConnect: false });
      status.classList.add("error");
      status.textContent = "Permission wasn't granted last time — click Connect to try again.";
    }
  }
}

async function attemptConnect(
  input: { serverUrl: string; email: string; password: string; deviceName: string },
  status: HTMLElement,
): Promise<void> {
  const { serverUrl, email, password, deviceName } = input;
  status.classList.remove("error");
  status.textContent = "Connecting…";

  try {
    await ensureCryptoReady();

    // Request the origin permission before making cross-origin requests
    // to the user's self-hosted server (docs/security.md, MV3 optional
    // host permissions model).
    const granted = await chrome.permissions.request({ origins: hostPermissionOrigins(serverUrl) });
    if (!granted) {
      await saveDraft<SetupDraft>(SETUP_DRAFT_KEY, { serverUrl, email, password, deviceName, pendingConnect: false });
      status.classList.add("error");
      status.textContent = "Permission to contact the server was not granted.";
      return;
    }

    const result = await registerDevice({
      serverUrl,
      email,
      password,
      name: deviceName,
      browser: "helium",
      extensionVersion: chrome.runtime.getManifest().version,
    });

    // docs/encryption.md §2: every device derives the same REK from the
    // account password + server-issued salt — no per-device
    // authorization step, no relay through another device.
    status.textContent = "Deriving encryption key…";
    const encryptionRootKey = await deriveRekFromPassword(password, result.encryptionSalt);

    const record: DeviceRecord = {
      id: "self",
      serverUrl,
      deviceId: result.deviceId,
      userId: "",
      email,
      accessToken: result.accessToken,
      accessTokenExpiresAt: result.accessTokenExpiresAt,
      refreshToken: result.refreshToken,
      encryptionRootKey,
      encryptionRootKeyVersion: 1,
    };
    await putDevice(record);
    await clearDraft(SETUP_DRAFT_KEY);

    // The background service worker's own module-scope startup logic
    // (background/index.ts's `ensureCryptoReady().then(initializeCaptureForSettings)`)
    // already ran once — likely before this device existed — so without
    // this it wouldn't register bookmark/history capture, run the initial
    // backfill, or open the WebSocket push-notification connection until
    // the next full service worker restart. This is the same signal
    // "save settings" already sends for the same reason.
    await chrome.runtime.sendMessage({ type: "REFRESH_CAPTURE_CONFIG" }).catch(() => {});

    connectedView = "status";
    await render();
  } catch (err) {
    await saveDraft<SetupDraft>(SETUP_DRAFT_KEY, { serverUrl, email, password, deviceName, pendingConnect: false });
    status.classList.add("error");
    status.textContent = `Failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function renderHeaderGear(): void {
  headerActions.innerHTML = `<button class="icon-button" id="open-settings" title="Settings">${GEAR_ICON}</button>`;
  document.getElementById("open-settings")?.addEventListener("click", async () => {
    connectedView = "settings";
    await render();
  });
}

function renderHeaderBack(): void {
  headerActions.innerHTML = `<button class="icon-button" id="back-to-status" title="Back">${BACK_ICON}</button>`;
  document.getElementById("back-to-status")?.addEventListener("click", async () => {
    connectedView = "status";
    await render();
  });
}

async function renderStatusView(device: DeviceRecord): Promise<void> {
  renderHeaderGear();

  const response = await chrome.runtime.sendMessage({ type: "GET_STATUS" });

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

  // The status card only ever says "Sync error" / "Needs re-authorization"
  // — useless for actually fixing anything without this. errorDetail is
  // the caught error's message (background/index.ts's GET_STATUS handler,
  // set in sync/engine.ts::runSyncCycle's catch block). Set via textContent,
  // not interpolated into the template above, since this can echo back
  // arbitrary text (e.g. a URL or server error string) that should never
  // be parsed as markup.
  if ((response.status === "error" || response.status === "needs_reauth") && response.errorDetail) {
    const detail = document.createElement("div");
    detail.className = "status-message error";
    detail.textContent = response.errorDetail;
    document.querySelector(".status-card")!.insertAdjacentElement("afterend", detail);
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

  const settings = await fetchSettings().catch(() => undefined);
  if (settings?.tabRestorePolicy === "ask") {
    const pending = await getPendingTabRestores();
    const restoreSection = renderPendingTabRestores(
      pending,
      async (objectId) => {
        const response = await chrome.runtime.sendMessage({ type: "RESTORE_TAB", objectId });
        // The background worker returns errors as a response rather than
        // rejecting the message promise. Treat those as failures so the
        // targeted row update leaves the tab visible and re-enables it.
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

  const historyList = renderHistoryList(await getSyncedHistoryVisits());
  if (historyList) app.appendChild(historyList);

  const footer = document.createElement("div");
  footer.className = "meta";
  footer.style.marginTop = "16px";
  footer.style.textAlign = "center";
  footer.textContent = `Signed in as ${device.email}`;
  app.appendChild(footer);
}

async function renderSettings(device: DeviceRecord): Promise<void> {
  renderHeaderBack();

  app.innerHTML = `
    <div class="account-row">
      <span class="email">${device.email}</span>
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
    <button id="save-settings" class="primary">Save</button>
    <div class="status-message" id="status"></div>
  `;

  document.getElementById("disconnect")?.addEventListener("click", async () => {
    const confirmed = await showConfirmDialog(
      "Disconnect this device? You can reconnect later, or revoke it from the web dashboard."
    );
    if (!confirmed) return;
    await clearDevice();
    await invalidateSettingsCache();
    await chrome.runtime.sendMessage({ type: "DEVICE_DISCONNECTED" }).catch(() => {});
    await clearDraft(SETTINGS_DRAFT_KEY);
    connectedView = "status";
    await render();
  });

  const status = document.getElementById("status")!;
  try {
    const settings = await fetchSettings();
    // An unsaved draft (left behind by a popup that closed before "Save"
    // was clicked) takes priority over the server's last-saved values —
    // otherwise the exact edits the user is trying to not lose would be
    // silently overwritten by the fetch that just ran.
    const draft = (await loadDraft<SettingsDraft>(SETTINGS_DRAFT_KEY)) ?? {};
    (document.getElementById("syncBookmarks") as HTMLInputElement).checked =
      draft.syncBookmarks ?? settings.syncBookmarks;
    (document.getElementById("syncHistory") as HTMLInputElement).checked = draft.syncHistory ?? settings.syncHistory;
    (document.getElementById("syncTabs") as HTMLInputElement).checked = draft.syncTabs ?? settings.syncTabs;
    (document.getElementById("syncTabGroups") as HTMLInputElement).checked =
      draft.syncTabGroups ?? settings.syncTabGroups;
    (document.getElementById("tabRestorePolicy") as HTMLSelectElement).value =
      draft.tabRestorePolicy ?? settings.tabRestorePolicy;
    (document.getElementById("historyRetention") as HTMLSelectElement).value =
      draft.historyRetention ?? settings.historyRetention;
  } catch (err) {
    status.classList.add("error");
    status.textContent = `Failed to load settings: ${err instanceof Error ? err.message : String(err)}`;
  }

  const persistSettingsDraft = () => {
    void saveDraft<SettingsDraft>(SETTINGS_DRAFT_KEY, {
      syncBookmarks: (document.getElementById("syncBookmarks") as HTMLInputElement).checked,
      syncHistory: (document.getElementById("syncHistory") as HTMLInputElement).checked,
      syncTabs: (document.getElementById("syncTabs") as HTMLInputElement).checked,
      syncTabGroups: (document.getElementById("syncTabGroups") as HTMLInputElement).checked,
      tabRestorePolicy: (document.getElementById("tabRestorePolicy") as HTMLSelectElement).value,
      historyRetention: (document.getElementById("historyRetention") as HTMLSelectElement).value,
    });
  };
  for (const id of ["syncBookmarks", "syncHistory", "syncTabs", "syncTabGroups"]) {
    document.getElementById(id)?.addEventListener("change", persistSettingsDraft);
  }
  for (const id of ["tabRestorePolicy", "historyRetention"]) {
    document.getElementById(id)?.addEventListener("change", persistSettingsDraft);
  }

  document.getElementById("save-settings")?.addEventListener("click", async () => {
    status.classList.remove("error");
    status.textContent = "Saving…";
    const patch: UpdateSettingsRequest = {
      syncBookmarks: (document.getElementById("syncBookmarks") as HTMLInputElement).checked,
      syncHistory: (document.getElementById("syncHistory") as HTMLInputElement).checked,
      syncTabs: (document.getElementById("syncTabs") as HTMLInputElement).checked,
      syncTabGroups: (document.getElementById("syncTabGroups") as HTMLInputElement).checked,
      tabRestorePolicy: (document.getElementById("tabRestorePolicy") as HTMLSelectElement)
        .value as UpdateSettingsRequest["tabRestorePolicy"],
      historyRetention: (document.getElementById("historyRetention") as HTMLSelectElement)
        .value as UpdateSettingsRequest["historyRetention"],
    };
    try {
      await updateSettings(patch);
      await clearDraft(SETTINGS_DRAFT_KEY);
      await chrome.runtime.sendMessage({ type: "REFRESH_CAPTURE_CONFIG" });
      status.textContent = "Saved.";
    } catch (err) {
      status.classList.add("error");
      status.textContent = `Failed to save: ${err instanceof Error ? err.message : String(err)}`;
    }
  });
}

render().catch((e) => {
  app.innerHTML = `<p class="meta">Failed to load: ${String(e)}</p>`;
});
