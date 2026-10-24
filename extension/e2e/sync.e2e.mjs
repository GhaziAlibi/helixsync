// End-to-end test of the built extension (dist/) in real browsers, against a
// local HelixSync stack. Two throwaway browser profiles act as two devices:
// one registers on the dashboard, both connect through the popup, and the
// test checks that bookmarks, history, open tabs and tab groups sync between
// them, that Disconnect revokes the device, and that login with device works.
// See CONTRIBUTING.md.
//
//   HELIXSYNC_E2E_BROWSER    Chromium-based browser to run (required). Branded
//                            Google Chrome ignores --load-extension; use
//                            Chromium, Helium, Brave, ...
//   HELIXSYNC_E2E_BROWSER_B  browser for the second device (default: the same)
//   HELIXSYNC_E2E_URL        the stack's dashboard origin
//                            (default http://localhost:5173)
import { chromium } from "playwright-core";
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { randomBytes } from "crypto";

const BASE = (process.env.HELIXSYNC_E2E_URL ?? "http://localhost:5173").replace(/\/$/, "");
const BROWSER_A = process.env.HELIXSYNC_E2E_BROWSER;
const BROWSER_B = process.env.HELIXSYNC_E2E_BROWSER_B ?? BROWSER_A;
const DIST = resolve(import.meta.dirname, "../dist");

if (!BROWSER_A) {
  console.error("Set HELIXSYNC_E2E_BROWSER to a Chromium-based browser, e.g. /usr/bin/chromium.");
  process.exit(2);
}
// It registers accounts, so it only ever talks to a local stack.
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(BASE).hostname)) {
  console.error(`HELIXSYNC_E2E_URL must be a local address, got ${BASE}.`);
  process.exit(2);
}
if (!existsSync(join(DIST, "manifest.json"))) {
  console.error("Build the extension first: npm run build");
  process.exit(2);
}

const WORK = mkdtempSync(join(tmpdir(), "helixsync-e2e-"));
const LOG = join(WORK, "console.log");
writeFileSync(LOG, "");

// The popup asks for permission to reach the server, and for tab groups when
// that sync is turned on; an automated browser can't click Chrome's prompts.
// Granting both in a copy's manifest makes the extension's own requests
// resolve at once (the test checks they are still made); nothing else changes.
const EXT = join(WORK, "extension");
cpSync(DIST, EXT, { recursive: true });
const manifest = JSON.parse(readFileSync(join(EXT, "manifest.json"), "utf8"));
const origin = new URL(BASE);
manifest.host_permissions = [`${origin.origin}/*`, `ws://${origin.host}/*`];
manifest.permissions = [...manifest.permissions, "tabGroups"];
manifest.optional_permissions = (manifest.optional_permissions ?? []).filter((p) => p !== "tabGroups");
writeFileSync(join(EXT, "manifest.json"), JSON.stringify(manifest, null, 2));

const EMAIL = `e2e-${Date.now()}@example.test`;
const PASSWORD = randomBytes(18).toString("base64url");
const RUN = Date.now().toString(36);
const BOOKMARK_URL = `https://example.com/helixsync-e2e-${RUN}`;
const HISTORY_URL = `${BASE}/helixsync-e2e-history-${RUN}`;
const ASLEEP_BOOKMARK_URL = `https://example.com/helixsync-e2e-asleep-${RUN}`;
const ASLEEP_HISTORY_URL = `${BASE}/helixsync-e2e-asleep-history-${RUN}`;
const TAB_URL = `${BASE}/helixsync-e2e-tab-${RUN}`;
const CLOSED_TAB_URL = `${BASE}/helixsync-e2e-closed-tab-${RUN}`;
const GROUPED_TAB_URL = `${BASE}/helixsync-e2e-grouped-tab-${RUN}`;

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`);
}

async function waitFor(fn, { timeout = 90_000, interval = 1_500 } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, interval));
  }
  return last;
}

function watchWorker(label, sw) {
  sw.on("console", (m) => appendFileSync(LOG, `[${label} worker ${m.type()}] ${m.text()}\n`));
}

async function launch(label, exe) {
  const ctx = await chromium.launchPersistentContext(mkdtempSync(join(WORK, `profile-${label}-`)), {
    executablePath: exe,
    headless: false,
    viewport: { width: 1000, height: 800 },
    args: ["--headless=new", `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-first-run", "--no-default-browser-check"],
  });
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker", { timeout: 15_000 }));
  watchWorker(label, sw);
  // A stopped worker restarts as a new one; keep `dev.sw` on the live one.
  const dev = { label, ctx, sw, id: new URL(sw.url()).host };
  ctx.on("serviceworker", (next) => {
    watchWorker(label, next);
    dev.sw = next;
  });
  return dev;
}

/** Runs `fn` on the device's extension worker entry in
 * chrome://serviceworker-internals. */
async function withWorkerInternals(dev, fn) {
  const page = await dev.ctx.newPage();
  try {
    await page.goto("chrome://serviceworker-internals/");
    return await fn(page.locator(".serviceworker-registration", { hasText: dev.id }));
  } finally {
    await page.close();
  }
}

/** Stops the device's extension service worker, as Chrome does when it is
 * idle. True once it reports STOPPED. */
const stopWorker = (dev) =>
  withWorkerInternals(dev, async (registration) => {
    await registration.getByRole("button", { name: "Stop" }).first().click();
    return waitFor(async () => /Running Status: STOPPED/.test(await registration.innerText()), { timeout: 15_000, interval: 500 });
  });

/** True once the device's extension service worker reports RUNNING. */
const workerRestarted = (dev) =>
  withWorkerInternals(dev, (registration) =>
    waitFor(async () => /Running Status: RUNNING/.test(await registration.innerText()), { timeout: 15_000, interval: 500 }),
  );

async function openPage(dev, url, kind) {
  const page = await dev.ctx.newPage();
  page.on("console", (m) => appendFileSync(LOG, `[${dev.label} ${kind} ${m.type()}] ${m.text()}\n`));
  page.on("pageerror", (e) => appendFileSync(LOG, `[${dev.label} ${kind} pageerror] ${e.message}\n`));
  try {
    await page.goto(url);
  } catch {
    // A navigation right after browser start is occasionally aborted.
    await page.waitForTimeout(1_000);
    await page.goto(url);
  }
  return page;
}

async function connect(dev, deviceName) {
  const popup = await openPage(dev, `chrome-extension://${dev.id}/popup.html`, "popup");
  await popup.fill("#serverUrl", BASE);
  await popup.fill("#email", EMAIL);
  await popup.fill("#password", PASSWORD);
  await popup.fill("#deviceName", deviceName);
  await popup.click('#setup-form button[type="submit"]');
  const connected = await popup
    .waitForSelector(".status-card", { timeout: 90_000 })
    .then(() => true)
    .catch(async () => `status: ${await popup.textContent("#status").catch(() => "?")}`);
  return { popup, connected };
}

const syncNow = (popup) => popup.evaluate(() => chrome.runtime.sendMessage({ type: "SYNC_NOW" }));
const findBookmark = (dev) => dev.sw.evaluate((url) => chrome.bookmarks.search({ url }), BOOKMARK_URL);
const listDevices = (page) => page.evaluate(() => fetch("/api/v1/devices").then((r) => r.json()));

/** Saves the popup's settings form with `changes` applied, returning the
 * form as it was before. Permission requests made while saving are recorded
 * in the popup's `__permissionRequests`. */
async function saveSettings(popup, changes) {
  await popup.click("#open-settings");
  // Enabled once the form holds the server's settings.
  await popup.waitForSelector("#save-settings:enabled", { timeout: 30_000 });
  await popup.evaluate(() => {
    globalThis.__permissionRequests = [];
    const request = chrome.permissions.request.bind(chrome.permissions);
    chrome.permissions.request = (permissions) => {
      globalThis.__permissionRequests.push(permissions);
      return request(permissions);
    };
  });
  const form = await popup.evaluate(() => ({
    syncTabs: document.getElementById("syncTabs").checked,
    syncTabGroups: document.getElementById("syncTabGroups").checked,
    tabRestorePolicy: document.getElementById("tabRestorePolicy").value,
  }));
  for (const [id, value] of Object.entries(changes)) {
    if (typeof value === "boolean") {
      // The checkbox sits inside a styled switch; click the switch like a user.
      if ((await popup.isChecked(`#${id}`)) !== value) {
        await popup.locator("label.switch", { has: popup.locator(`#${id}`) }).click();
      }
    } else {
      await popup.selectOption(`#${id}`, value);
    }
  }
  await popup.click("#save-settings");
  await popup.waitForSelector(".status-card", { timeout: 30_000 });
  return { formBefore: form };
}

/** Local tabs whose URL is `url`, with their group's state. */
const tabsAt = (dev, url) =>
  dev.sw.evaluate(async (url) => {
    const tabs = (await chrome.tabs.query({})).filter((t) => t.url === url);
    return Promise.all(
      tabs.map(async (t) => {
        if (t.groupId === -1 || !chrome.tabGroups) return { id: t.id, group: null };
        const g = await chrome.tabGroups.get(t.groupId);
        return { id: t.id, group: { title: g.title, color: g.color, collapsed: g.collapsed } };
      }),
    );
  }, url);

/** URLs listed under "Tabs from other devices" in the popup. */
async function pendingRestores(popup) {
  await popup.reload();
  await popup.waitForSelector(".status-card");
  return popup.locator(".restore-item .item-title").evaluateAll((items) => items.map((i) => i.title));
}

async function syncUntil(popups, predicate, timeout) {
  return waitFor(async () => {
    for (const p of popups) await syncNow(p).catch(() => {});
    return predicate();
  }, { timeout });
}

const devices = [];
try {
  const a = await launch("A", BROWSER_A);
  const b = await launch("B", BROWSER_B);
  devices.push(a, b);
  console.log(`server ${BASE}, device A ${BROWSER_A}, device B ${BROWSER_B}`);

  // Register on the dashboard, in A's browser.
  const dash = await openPage(a, `${BASE}/login?mode=register`, "dashboard");
  await dash.fill('input[type="email"]', EMAIL);
  const passwords = dash.locator('input[type="password"]');
  await passwords.nth(0).fill(PASSWORD);
  await passwords.nth(1).fill(PASSWORD);
  await dash.locator('form input[type="checkbox"]').check();
  await dash.getByRole("button", { name: "Create account" }).click();
  const savedCode = dash.getByText("I saved my recovery code somewhere safe.");
  check("dashboard: register shows the recovery code", await savedCode.waitFor({ timeout: 60_000 }).then(() => true, () => false));
  await savedCode.click();
  await dash.getByRole("button", { name: "Continue to HelixSync" }).click();
  await dash.waitForURL(`${BASE}/`, { timeout: 30_000 }).catch(() => {});
  check("dashboard: signed in after registering", dash.url() === `${BASE}/`, dash.url());

  // Connect both extensions with the password.
  const ca = await connect(a, "E2E device A");
  check("extension A: connects with email and password", ca.connected === true, ca.connected === true ? "" : ca.connected);
  const cb = await connect(b, "E2E device B");
  check("extension B: connects with email and password", cb.connected === true, cb.connected === true ? "" : cb.connected);
  const active = (await listDevices(dash)).filter((d) => !d.revokedAt).map((d) => d.name).sort();
  check("dashboard: lists both devices", JSON.stringify(active) === JSON.stringify(["E2E device A", "E2E device B"]), active.join(", "));

  // A bookmark created in A reaches B.
  await a.sw.evaluate((url) => chrome.bookmarks.create({ parentId: "1", title: "HelixSync E2E", url }), BOOKMARK_URL);
  check("sync: bookmark created in A appears in B", (await syncUntil([ca.popup, cb.popup], async () => (await findBookmark(b)).length === 1, 90_000)) === true);
  const created = (await findBookmark(b))[0];
  check("sync: bookmark keeps its title and folder", created?.title === "HelixSync E2E" && created?.parentId === "1", created ? `${created.title}, parent ${created.parentId}` : "missing");

  // A rename in B, right after the bookmark arrived there, reaches A.
  if (created) await b.sw.evaluate((id) => chrome.bookmarks.update(id, { title: "HelixSync E2E renamed" }), created.id);
  check("sync: rename in B appears in A", (await syncUntil([cb.popup, ca.popup], async () => (await findBookmark(a))[0]?.title === "HelixSync E2E renamed", 90_000)) === true);

  // A history visit in A is added to B's browser history.
  await (await openPage(a, HISTORY_URL, "page")).close();
  const inHistory = await syncUntil([ca.popup, cb.popup], async () => {
    const items = await b.sw.evaluate((url) => chrome.history.search({ text: url, startTime: 0, maxResults: 10 }), HISTORY_URL);
    return items.some((i) => i.url === HISTORY_URL);
  }, 120_000);
  check("sync: history visit in A is added to B's history", inHistory === true);

  // A delete in A reaches B.
  const [inA] = await findBookmark(a);
  if (inA) await a.sw.evaluate((id) => chrome.bookmarks.remove(id), inA.id);
  check("sync: delete in A removes it from B", (await syncUntil([ca.popup, cb.popup], async () => (await findBookmark(b)).length === 0, 90_000)) === true);

  await ca.popup.reload();
  const statusA = (await ca.popup.textContent(".status-card"))?.replace(/\s+/g, " ").trim();
  check("extension A: popup reports Synced", statusA?.startsWith("Synced") ?? false, statusA);

  // Changes made while A's worker is stopped (Chrome stops it when idle). The
  // event itself wakes the worker, which must still capture it. The popup is
  // already rendered and only messages the worker on clicks, so nothing else
  // wakes it.
  const workerStopped = await stopWorker(a);
  check("worker: A's service worker stops", workerStopped === true);
  await ca.popup.evaluate((url) => chrome.bookmarks.create({ parentId: "1", title: "Made while asleep", url }), ASLEEP_BOOKMARK_URL);
  const asleepBookmark = await syncUntil([cb.popup], async () => {
    const found = await b.sw.evaluate((url) => chrome.bookmarks.search({ url }), ASLEEP_BOOKMARK_URL);
    return found.length === 1;
  }, 90_000);
  check("sync: a bookmark created while A's worker was stopped reaches B", asleepBookmark === true);
  check("worker: A's service worker stops again", (await stopWorker(a)) === true);
  await (await openPage(a, ASLEEP_HISTORY_URL, "page")).close();
  // Visits wait for the next sync instead of starting one (history/index.ts),
  // so A is synced from here once the visit itself has restarted its worker.
  check("worker: a page visit restarts A's stopped worker", (await workerRestarted(a)) === true);
  const asleepVisit = await syncUntil([ca.popup, cb.popup], async () => {
    const items = await b.sw.evaluate((url) => chrome.history.search({ text: url, startTime: 0, maxResults: 10 }), ASLEEP_HISTORY_URL);
    return items.some((i) => i.url === ASLEEP_HISTORY_URL);
  }, 120_000);
  check("sync: a page visited while A's worker was stopped reaches B's history", asleepVisit === true);

  // Tabs and tab groups. Off by default, and account-wide: turned on in A's
  // popup with "ask before restoring", then saved again in B's.
  const saveA = await saveSettings(ca.popup, { syncTabs: true, syncTabGroups: true, tabRestorePolicy: "ask" });
  check(
    "settings: tab and tab group sync are off by default",
    !saveA.formBefore.syncTabs && !saveA.formBefore.syncTabGroups && saveA.formBefore.tabRestorePolicy === "disabled",
    JSON.stringify(saveA.formBefore),
  );
  const askedForGroups = (await ca.popup.evaluate(() => globalThis.__permissionRequests ?? [])).some((r) => r.permissions?.includes("tabGroups"));
  check("settings: saving with Tab Groups on requests the tabGroups permission", askedForGroups);
  const saveB = await saveSettings(cb.popup, {});
  check(
    "settings: B shows the account-wide settings saved in A",
    saveB.formBefore.syncTabs && saveB.formBefore.syncTabGroups && saveB.formBefore.tabRestorePolicy === "ask",
    JSON.stringify(saveB.formBefore),
  );

  // "Ask": a tab opened in A is offered in B's popup, and Restore opens it.
  const tabPage = await openPage(a, TAB_URL, "page");
  const offered = await syncUntil([ca.popup, cb.popup], async () => (await pendingRestores(cb.popup)).includes(TAB_URL), 90_000);
  check("tabs (ask): a tab opened in A is listed in B's popup", offered === true);
  check("tabs (ask): it is not opened in B before Restore", (await tabsAt(b, TAB_URL)).length === 0);
  await cb.popup.locator(".restore-item", { has: cb.popup.locator(`.item-title[title="${TAB_URL}"]`) }).getByRole("button", { name: "Restore" }).click();
  const restored = await waitFor(async () => (await tabsAt(b, TAB_URL)).length === 1, { timeout: 30_000 });
  check("tabs (ask): Restore opens the tab in B", restored === true);

  // A tab closed in A drops out of B's list.
  const closedPage = await openPage(a, CLOSED_TAB_URL, "page");
  const listed = await syncUntil([ca.popup, cb.popup], async () => (await pendingRestores(cb.popup)).includes(CLOSED_TAB_URL), 90_000);
  await closedPage.close();
  const dropped = await syncUntil([ca.popup, cb.popup], async () => !(await pendingRestores(cb.popup)).includes(CLOSED_TAB_URL), 90_000);
  check("tabs (ask): a tab closed in A leaves B's list", listed === true && dropped === true);

  // "Automatic": a grouped tab opened in A opens in B, in a matching group.
  await saveSettings(cb.popup, { tabRestorePolicy: "automatic" });
  await a.sw.evaluate(async (url) => {
    const tab = await chrome.tabs.create({ url, active: false });
    const groupId = await chrome.tabs.group({ tabIds: tab.id });
    await chrome.tabGroups.update(groupId, { title: "E2E group", color: "purple" });
  }, GROUPED_TAB_URL);
  const grouped = await syncUntil([ca.popup, cb.popup], async () => {
    const [t] = await tabsAt(b, GROUPED_TAB_URL);
    return t?.group?.title === "E2E group" && t.group.color === "purple";
  }, 90_000);
  const groupedTab = (await tabsAt(b, GROUPED_TAB_URL))[0];
  check("tab groups (automatic): a grouped tab in A opens in B in a group with the same title and color", grouped === true, JSON.stringify(groupedTab));

  // Changes to the group in A reach B's group.
  await a.sw.evaluate(async (url) => {
    const [tab] = (await chrome.tabs.query({})).filter((t) => t.url === url);
    await chrome.tabGroups.update(tab.groupId, { title: "E2E group renamed", color: "green", collapsed: true });
  }, GROUPED_TAB_URL);
  const updated = await syncUntil([ca.popup, cb.popup], async () => {
    const [t] = await tabsAt(b, GROUPED_TAB_URL);
    return t?.group?.title === "E2E group renamed" && t.group.color === "green" && t.group.collapsed === true;
  }, 90_000);
  check("tab groups: title, color and collapsed state changed in A reach B", updated === true, JSON.stringify((await tabsAt(b, GROUPED_TAB_URL))[0]));
  await tabPage.close();

  // Disconnect B from its popup: the server revokes the device.
  await cb.popup.reload();
  await cb.popup.click("#open-settings");
  await cb.popup.click("#disconnect");
  await cb.popup.click("#modal-confirm");
  const backToSetup = await cb.popup.waitForSelector("#setup-form", { timeout: 30_000 }).then(() => true, () => false);
  const bRow = (await listDevices(dash)).find((d) => d.name === "E2E device B");
  check("extension B: Disconnect revokes the device", backToSetup && !!bRow?.revokedAt);

  // Login with device: B's browser signs in to the dashboard, approved from A.
  const login = await openPage(b, `${BASE}/login`, "dashboard");
  await login.fill('input[type="email"]', EMAIL);
  await login.getByRole("button", { name: "Log in with a device" }).click();
  await login.locator("code").waitFor({ timeout: 30_000 });
  const phrase = (await login.locator("code").textContent())?.trim();
  const request = await waitFor(async () => {
    await ca.popup.reload();
    const card = ca.popup.locator(".auth-request");
    return (await card.count()) > 0 ? card.first() : null;
  }, { timeout: 30_000 });
  const shown = request ? (await request.locator(".fingerprint").first().textContent())?.trim() : undefined;
  check("login with device: A shows the request with the same phrase", !!phrase && phrase === shown, `${phrase} / ${shown}`);
  if (request) await request.getByRole("button", { name: "Approve" }).click();
  await login.waitForURL(`${BASE}/`, { timeout: 30_000 }).catch(() => {});
  const me = await login.evaluate(() => fetch("/api/v1/auth/me").then((r) => r.status));
  check("login with device: B's dashboard is signed in", login.url() === `${BASE}/` && me === 200, `/me ${me}`);
} catch (e) {
  check("test ran to completion", false, e.message.split("\n")[0]);
} finally {
  for (const d of devices) await d.ctx.close().catch(() => {});
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
if (failed) {
  console.log(`Browser console output and profiles kept in ${WORK}`);
} else {
  rmSync(WORK, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
