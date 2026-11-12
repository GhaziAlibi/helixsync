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
//   HELIXSYNC_E2E_BROWSER_B  browser for the second device (default: the same).
//                            Firefox works here (it runs dist-firefox/ over
//                            WebDriver BiDi) and adds Firefox-only checks.
//   HELIXSYNC_E2E_URL        the stack's dashboard origin
//                            (default http://localhost:5173)
import { chromium } from "playwright-core";
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, join, resolve } from "path";
import { randomBytes } from "crypto";
import { launchFirefox, prepareFirefoxExtension } from "./firefox-device.mjs";

const BASE = (process.env.HELIXSYNC_E2E_URL ?? "http://localhost:5173").replace(/\/$/, "");
const BROWSER_A = process.env.HELIXSYNC_E2E_BROWSER;
const BROWSER_B = process.env.HELIXSYNC_E2E_BROWSER_B ?? BROWSER_A;
const DIST = resolve(import.meta.dirname, "../dist");
const DIST_FIREFOX = resolve(import.meta.dirname, "../dist-firefox");
const isFirefox = (exe) => /firefox/i.test(basename(exe ?? ""));

if (!BROWSER_A) {
  console.error("Set HELIXSYNC_E2E_BROWSER to a Chromium-based browser, e.g. /usr/bin/chromium.");
  process.exit(2);
}
// It registers accounts, so it only ever talks to a local stack.
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(BASE).hostname)) {
  console.error(`HELIXSYNC_E2E_URL must be a local address, got ${BASE}.`);
  process.exit(2);
}
// A's checks stop Chromium's service worker and use its virtual authenticator.
if (isFirefox(BROWSER_A)) {
  console.error("HELIXSYNC_E2E_BROWSER must be Chromium-based; put Firefox in HELIXSYNC_E2E_BROWSER_B.");
  process.exit(2);
}
if (!existsSync(join(DIST, "manifest.json"))) {
  console.error("Build the extension first: npm run build");
  process.exit(2);
}
if (isFirefox(BROWSER_B) && !existsSync(join(DIST_FIREFOX, "manifest.json"))) {
  console.error("Build the Firefox extension first: npm run build:firefox");
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
// Likewise "notifications" (send tab's optional toast), so the toast path runs.
manifest.permissions = [...manifest.permissions, "notifications"];
manifest.optional_permissions = (manifest.optional_permissions ?? []).filter((p) => p !== "tabGroups" && p !== "notifications");
writeFileSync(join(EXT, "manifest.json"), JSON.stringify(manifest, null, 2));
const EXT_FIREFOX = join(WORK, "extension-firefox");
const stopFirefoxLog = isFirefox(BROWSER_B) ? await prepareFirefoxExtension(DIST_FIREFOX, EXT_FIREFOX, LOG, "B") : () => {};

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
const SEND_URL = `${BASE}/helixsync-e2e-send-${RUN}`;
const SEND_URL_B = `${BASE}/helixsync-e2e-send-b-${RUN}`;
const HISTORY_URL_B = `${BASE}/helixsync-e2e-history-b-${RUN}`;
const TAB_URL_B = `${BASE}/helixsync-e2e-tab-b-${RUN}`;

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
  if (isFirefox(exe)) {
    const dev = await launchFirefox({ label, exe, work: WORK, extDir: EXT_FIREFOX, log: LOG });
    return Object.assign(dev, { bar: "toolbar_____" });
  }
  const profile = mkdtempSync(join(WORK, `profile-${label}-`));
  const dev = { label, kind: "chromium", bar: "1" };
  /** Starts (or, after `ctx.close()`, restarts) the browser on the same
   * profile, as quitting and reopening it does. */
  dev.start = async () => {
    const ctx = await chromium.launchPersistentContext(profile, {
      executablePath: exe,
      headless: false,
      viewport: { width: 1000, height: 800 },
      args: ["--headless=new", "--lang=en-US", `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-first-run", "--no-default-browser-check"],
    });
    const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker", { timeout: 15_000 }));
    watchWorker(label, sw);
    const id = new URL(sw.url()).host;
    Object.assign(dev, { ctx, sw, id, extensionOrigin: `chrome-extension://${id}` });
    // A stopped worker restarts as a new one; keep `dev.sw` on the live one.
    ctx.on("serviceworker", (next) => {
      watchWorker(label, next);
      dev.sw = next;
    });
  };
  await dev.start();
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
  if (dev.kind === "firefox") return dev.newPage(url, kind);
  const page = await dev.ctx.newPage();
  page.on("console", (m) => appendFileSync(LOG, `[${dev.label} ${kind} ${m.type()}] ${m.text()}\n`));
  page.on("pageerror", (e) => appendFileSync(LOG, `[${dev.label} ${kind} pageerror] ${e.message}\n`));
  page.on("dialog", (d) => d.accept().catch(() => {}));
  // A navigation right after browser start is occasionally aborted, and
  // right after the extension reloads its pages are blocked until it is back.
  for (let attempt = 0; ; attempt++) {
    try {
      await page.goto(url);
      return page;
    } catch (e) {
      if (attempt >= 20) throw e;
      await page.waitForTimeout(1_000);
    }
  }
}

async function connect(dev, deviceName) {
  const popup = await openPage(dev, `${dev.extensionOrigin}/popup.html`, "popup");
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
    historyRetention: document.getElementById("historyRetention").value,
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

let RECOVERY_CODE = "";
let CURRENT_PASSWORD = PASSWORD;

/** Restarts the extension and returns a fresh popup once it is back:
 * Chromium quits and reopens the browser on the same profile; Firefox, whose
 * test add-on is temporary (gone when the browser quits), reloads it, which
 * restarts its background page the same way. */
async function restartExtension(dev) {
  if (dev.kind === "firefox") {
    await dev.sw.evaluate(() => {
      setTimeout(() => chrome.runtime.reload(), 100);
    }).catch(() => {});
    await dev.reopenApi();
  } else {
    await dev.ctx.close();
    await dev.start();
  }
  const popup = await openPage(dev, `${dev.extensionOrigin}/popup.html`, "popup");
  await popup.waitForSelector(".status-card", { timeout: 60_000 }).catch(() => {});
  return popup;
}

/** A dashboard page in A's browser, signing in first if the session is gone. */
async function dashboardPage(path) {
  const page = await openPage(devices[0], `${BASE}${path}`, "dashboard");
  await page.waitForLoadState("networkidle").catch(() => {});
  if (new URL(page.url()).pathname === "/login") {
    await page.fill('input[type="email"]', EMAIL);
    await page.fill('input[type="password"]', CURRENT_PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).first().click();
    await page.waitForURL(`${BASE}/`, { timeout: 15_000 }).catch(() => {});
    await page.goto(`${BASE}${path}`);
    await page.waitForLoadState("networkidle").catch(() => {});
  }
  return page;
}

const countByUrl = (dev, url) => dev.sw.evaluate((url) => chrome.bookmarks.search({ url }).then((r) => r.length), url);
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
  // The code is shown once; the screen stays until it is typed back.
  const codeBox = dash.locator("code").first();
  const codeShown = await codeBox.waitFor({ timeout: 60_000 }).then(() => true, () => false);
  check("dashboard: register shows the recovery code", codeShown);
  RECOVERY_CODE = (await codeBox.innerText()).trim();
  await dash.locator('input[placeholder^="XXXX-"]').fill(RECOVERY_CODE);
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

  // Send tab to device (docs/protocol.md §12.5), before tab sync is on so the
  // tabs opened here are not captured. Both devices are connected now.
  {
    const bId = (await listDevices(dash)).find((d) => d.name === "E2E device B")?.id;
    const aId = (await listDevices(dash)).find((d) => d.name === "E2E device A")?.id;
    const sendTab = (popup, deviceId, url) => popup.evaluate((args) => chrome.runtime.sendMessage({ type: "SEND_TAB", ...args }), { deviceId, url });
    const closeTabsAt = (dev, url) =>
      dev.sw.evaluate(async (url) => {
        for (const t of await chrome.tabs.query({})) if (t.url === url) await chrome.tabs.remove(t.id);
      }, url);
    const isOnline = async (name) => (await listDevices(dash)).find((d) => d.name === name)?.online;

    check("send tab: both devices report online once connected", (await waitFor(async () => (await isOnline("E2E device A")) && (await isOnline("E2E device B")), { timeout: 60_000, interval: 1_000 })) === true);

    // The picker, as a user sees it: the popup lists B as online and a click sends.
    const picker = await a.ctx.newPage();
    picker.on("console", (m) => appendFileSync(LOG, `[A popup ${m.type()}] ${m.text()}\n`));
    picker.on("pageerror", (e) => appendFileSync(LOG, `[A popup pageerror] ${e.message}\n`));
    // The popup is opened as a tab here, so give it a web page as "this tab".
    await picker.addInitScript((url) => {
      if (globalThis.chrome?.tabs) chrome.tabs.query = async () => [{ id: 1, url, title: "Sent from A" }];
    }, SEND_URL);
    await picker.goto(`${a.extensionOrigin}/popup.html`);
    const bButton = picker.locator("button", { hasText: "E2E device B" });
    const listed = await bButton.waitFor({ timeout: 30_000 }).then(() => true, () => false);
    check("send tab: the popup lists the other device", listed);
    check("send tab: the popup shows its online state", listed && /online/.test(await bButton.innerText()) && !/offline/.test(await bButton.innerText()), listed ? (await bButton.innerText()).replace(/\s+/g, " ") : "");
    check("send tab: the popup does not list this device", (await picker.locator("button", { hasText: "E2E device A" }).count()) === 0);
    await b.sw.evaluate(() => {
      globalThis.__sendTabCreated = [];
      chrome.tabs.onCreated.addListener((t) => globalThis.__sendTabCreated.push({ url: t.url || t.pendingUrl, active: t.active }));
    });
    if (listed) await bButton.click();
    const sentMessage = await picker.locator(".status-message", { hasText: "Sent to E2E device B" }).waitFor({ timeout: 20_000 }).then(() => true, () => false);
    check("send tab: the popup reports the tab as sent", sentMessage, sentMessage ? "" : await picker.locator(".status-message").allInnerTexts().then((t) => t.join(" | ")));
    const openedInB = await waitFor(async () => (await tabsAt(b, SEND_URL)).length > 0, { timeout: 30_000, interval: 500 });
    check("send tab: the tab sent from A opens in B", openedInB === true);
    // As created (the harness's own pages may take focus afterwards).
    const createdInB = await b.sw.evaluate((url) => globalThis.__sendTabCreated ?? [], SEND_URL).catch(() => []);
    check("send tab: it opens as the active tab", createdInB.length > 0 && createdInB.every((t) => t.active), JSON.stringify(createdInB));
    // Every tab created while the tab was sent is the one it opened.
    await closeTabsAt(b, SEND_URL);

    // The context menu was rebuilt when the popup listed devices: B's entry and
    // the parent exist, this device's own does not.
    const probe = (id) =>
      a.sw.evaluate(
        (id) => new Promise((resolve) => chrome.contextMenus.create({ id, title: "probe", contexts: ["page"] }, () => resolve(chrome.runtime.lastError?.message ?? "created"))),
        id,
      );
    check("send tab: the context menu has an entry for the other device", /duplicate/i.test(await probe(`helixsync-send-tab:${bId}`)));
    check("send tab: the context menu has its parent entry", /duplicate/i.test(await probe("helixsync-send-tab")));
    check("send tab: the context menu has no entry for this device", (await probe(`helixsync-send-tab:${aId}`)) === "created");
    await a.sw.evaluate((id) => chrome.contextMenus.remove(id), `helixsync-send-tab:${aId}`).catch(() => {});
    await picker.close();

    // The optional notifications toggle in the settings is offered.
    const settingsPage = await openPage(a, `${a.extensionOrigin}/popup.html`, "popup");
    await settingsPage.click("#open-settings");
    const toggleShown = await settingsPage.waitForSelector("#send-tab-settings:not([hidden])", { timeout: 30_000 }).then(() => true, () => false);
    check("send tab: the settings offer the notifications toggle", toggleShown);
    check("send tab: the toggle reflects the granted permission", toggleShown && (await settingsPage.isChecked("#sendTabNotifications")));
    await settingsPage.close();

    // The other way: B sends to A, which opens it and shows a notification.
    await a.sw.evaluate(() => {
      globalThis.__notes = [];
      const create = chrome.notifications.create.bind(chrome.notifications);
      chrome.notifications.create = (...args) => {
        globalThis.__notes.push(args.find((x) => typeof x === "object"));
        return create(...args);
      };
    });
    const sentBA = await sendTab(cb.popup, aId, SEND_URL_B);
    check("send tab: B's send is reported as delivered", sentBA?.ok === true, JSON.stringify(sentBA));
    check("send tab: the tab sent from B opens in A", (await waitFor(async () => (await tabsAt(a, SEND_URL_B)).length > 0, { timeout: 30_000, interval: 500 })) === true);
    const note = await waitFor(async () => (await a.sw.evaluate(() => globalThis.__notes))?.[0], { timeout: 15_000, interval: 500 });
    check("send tab: the receiving device shows a notification naming the sender", note?.title === "Tab from E2E device B", JSON.stringify(note));
    await closeTabsAt(a, SEND_URL_B);

    // Refused before anything is sent.
    const bad = await sendTab(ca.popup, bId, "javascript:alert(1)");
    check("send tab: a non-web address is refused", bad?.ok === false && bad.reason === "bad_url", JSON.stringify(bad));

    // A device that isn't connected is reported, and nothing is kept for it.
    if (b.kind === "chromium") {
      const stopped = await stopWorker(b);
      const wentOffline = stopped && (await waitFor(async () => (await isOnline("E2E device B")) === false, { timeout: 30_000, interval: 1_000 }));
      check("send tab: a device whose worker stopped is listed offline", wentOffline === true);
      const offline = await sendTab(ca.popup, bId, SEND_URL);
      check("send tab: sending to an offline device says so", offline?.ok === false && offline.reason === "offline", JSON.stringify(offline));
      // Waking B reconnects it, and the missed tab is not delivered later.
      await syncNow(cb.popup).catch(() => {});
      const back = await waitFor(async () => (await isOnline("E2E device B")) === true, { timeout: 60_000, interval: 1_000 });
      check("send tab: the device is online again after its worker restarts", back === true);
      await new Promise((r) => setTimeout(r, 3_000));
      check("send tab: nothing was queued for the offline device", (await tabsAt(b, SEND_URL)).length === 0);
    }
  }

  // A bookmark created in A reaches B.
  await a.sw.evaluate((url) => chrome.bookmarks.create({ parentId: "1", title: "HelixSync E2E", url }), BOOKMARK_URL);
  check("sync: bookmark created in A appears in B", (await syncUntil([ca.popup, cb.popup], async () => (await findBookmark(b)).length === 1, 90_000)) === true);
  const created = (await findBookmark(b))[0];
  check("sync: bookmark keeps its title and folder", created?.title === "HelixSync E2E" && created?.parentId === b.bar, created ? `${created.title}, parent ${created.parentId}` : "missing");

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

  // And the other way: a visit in B is added to A's history.
  await (await openPage(b, HISTORY_URL_B, "page")).close();
  const inHistoryA = await syncUntil([cb.popup, ca.popup], async () => {
    const items = await a.sw.evaluate((url) => chrome.history.search({ text: url, startTime: 0, maxResults: 10 }), HISTORY_URL_B);
    return items.some((i) => i.url === HISTORY_URL_B);
  }, 120_000);
  check("sync: history visit in B is added to A's history", inHistoryA === true);

  if (b.kind === "firefox") {
    // Separators: Firefox's become separator.floccus.org bookmarks on
    // Chromium, and those become separators again on Firefox.
    const SEPARATOR_URL = "https://separator.floccus.org/";
    const barKids = (dev) => dev.sw.evaluate(async (bar) => (await chrome.bookmarks.getChildren(bar)).map((n) => ({ type: n.type, url: n.url, title: n.title })), dev.bar);
    const separatorsIn = async (dev) =>
      (await barKids(dev)).filter((n) => (dev.kind === "firefox" ? n.type === "separator" : n.url === SEPARATOR_URL)).length;
    await b.sw.evaluate((bar) => chrome.bookmarks.create({ parentId: bar, type: "separator" }), b.bar);
    check(
      "firefox: a separator made in B reaches A as a separator.floccus.org bookmark",
      (await syncUntil([cb.popup, ca.popup], async () => (await separatorsIn(a)) === 1, 90_000)) === true,
      JSON.stringify((await barKids(a)).filter((n) => n.url === SEPARATOR_URL)),
    );
    await a.sw.evaluate((args) => chrome.bookmarks.create({ parentId: args.bar, title: "⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯", url: args.url }), { bar: a.bar, url: SEPARATOR_URL });
    check(
      "firefox: a separator.floccus.org bookmark made in A becomes a separator in B",
      (await syncUntil([ca.popup, cb.popup], async () => (await separatorsIn(b)) === 2, 90_000)) === true,
      `${await separatorsIn(b)} separators in B`,
    );
    check("firefox: no extra separator bookmark appears in A", (await separatorsIn(a)) === 2, `${await separatorsIn(a)} in A`);
    check(
      "firefox: B's separators are real separators, not bookmarks",
      (await barKids(b)).every((n) => n.url !== SEPARATOR_URL),
    );

    // Bookmarks Menu: Chromium shows it as "Bookmarks menu" in Other bookmarks.
    const MENU_URL_B = `https://example.com/helixsync-e2e-menu-b-${RUN}`;
    const MENU_URL_A = `https://example.com/helixsync-e2e-menu-a-${RUN}`;
    const parentOf = async (dev, url) =>
      dev.sw.evaluate(async (url) => {
        const [n] = await chrome.bookmarks.search({ url });
        if (!n) return null;
        const [parent] = await chrome.bookmarks.get(n.parentId);
        return { id: parent.id, title: parent.title, parentId: parent.parentId };
      }, url);
    await b.sw.evaluate((url) => chrome.bookmarks.create({ parentId: "menu________", title: "Menu E2E from B", url }), MENU_URL_B);
    const menuInA = await syncUntil([cb.popup, ca.popup], async () => {
      const p = await parentOf(a, MENU_URL_B);
      return p && p.title === "Bookmarks menu" && p.parentId === "2" ? p : null;
    }, 90_000);
    check("firefox: a bookmark in B's Bookmarks Menu reaches A in Other bookmarks > Bookmarks menu", !!menuInA, JSON.stringify(await parentOf(a, MENU_URL_B)));
    if (menuInA) await a.sw.evaluate((args) => chrome.bookmarks.create({ parentId: args.id, title: "Menu E2E from A", url: args.url }), { id: menuInA.id, url: MENU_URL_A });
    check(
      "firefox: a bookmark put in A's Bookmarks menu folder reaches B's Bookmarks Menu",
      (await syncUntil([ca.popup, cb.popup], async () => (await parentOf(b, MENU_URL_A))?.id === "menu________", 90_000)) === true,
      JSON.stringify(await parentOf(b, MENU_URL_A)),
    );
  }

  // A delete in A reaches B.
  const [inA] = await findBookmark(a);
  if (inA) await a.sw.evaluate((id) => chrome.bookmarks.remove(id), inA.id);
  check("sync: delete in A removes it from B", (await syncUntil([ca.popup, cb.popup], async () => (await findBookmark(b)).length === 0, 90_000)) === true);

  // A bookmark moved to another folder in A moves in B.
  {
    const MOVE_URL = `https://example.com/helixsync-e2e-move-${RUN}`;
    const ids = await a.sw.evaluate(async (args) => {
      const from = await chrome.bookmarks.create({ parentId: args.bar, title: `Move from ${args.run}` });
      const to = await chrome.bookmarks.create({ parentId: args.bar, title: `Move to ${args.run}` });
      const bm = await chrome.bookmarks.create({ parentId: from.id, title: "Moving", url: args.url });
      return { to: to.id, bm: bm.id };
    }, { bar: a.bar, run: RUN, url: MOVE_URL });
    const parentTitleIn = (dev) =>
      dev.sw.evaluate(async (url) => {
        const [n] = await chrome.bookmarks.search({ url });
        return n ? (await chrome.bookmarks.get(n.parentId))[0].title : null;
      }, MOVE_URL);
    await syncUntil([ca.popup, cb.popup], async () => (await parentTitleIn(b)) === `Move from ${RUN}`, 90_000);
    await a.sw.evaluate((ids) => chrome.bookmarks.move(ids.bm, { parentId: ids.to }), ids);
    check(
      "sync: a bookmark moved to another folder in A moves in B",
      (await syncUntil([ca.popup, cb.popup], async () => (await parentTitleIn(b)) === `Move to ${RUN}`, 90_000)) === true,
      String(await parentTitleIn(b)),
    );
    check("sync: the moved bookmark is not duplicated in B", (await countByUrl(b, MOVE_URL)) === 1, `${await countByUrl(b, MOVE_URL)} in B`);
  }

  // Live updates: nothing presses Sync; A's change reaches B over the
  // server's WebSocket notification.
  {
    const LIVE_URL = `https://example.com/helixsync-e2e-live-${RUN}`;
    await a.sw.evaluate((args) => chrome.bookmarks.create({ parentId: args.bar, title: "Live", url: args.url }), { bar: a.bar, url: LIVE_URL });
    check("sync: a change in A reaches B without pressing Sync (live update)", (await waitFor(async () => (await countByUrl(b, LIVE_URL)) === 1, { timeout: 60_000 })) === true);
  }

  // Restarting B's extension (a browser restart or an update): it comes back
  // connected and keeps syncing.
  {
    cb.popup = await restartExtension(b);
    const statusB = (await cb.popup.textContent(".status-card").catch(() => ""))?.replace(/\s+/g, " ").trim();
    check("restart: B's extension comes back connected", /^Synced|^Syncing/.test(statusB ?? ""), statusB);
    const AFTER_RESTART_URL = `https://example.com/helixsync-e2e-after-restart-${RUN}`;
    await a.sw.evaluate((args) => chrome.bookmarks.create({ parentId: args.bar, title: "After restart", url: args.url }), { bar: a.bar, url: AFTER_RESTART_URL });
    check(
      "restart: B keeps syncing after the restart",
      (await syncUntil([ca.popup, cb.popup], async () => (await countByUrl(b, AFTER_RESTART_URL)) === 1, 90_000)) === true,
    );
  }

  // Restore points: A deletes a folder with children, B syncs it away, and A
  // restores it from a point; B gets the folder and its children back.
  const RESTORE_FOLDER = `Restore folder ${RUN}`;
  const restoreKids = [`${BASE}/helixsync-e2e-kid-1-${RUN}`, `${BASE}/helixsync-e2e-kid-2-${RUN}`];
  const folderIn = (dev) => dev.sw.evaluate((title) => chrome.bookmarks.search({ title }).then((r) => r.filter((n) => !n.url)), RESTORE_FOLDER);
  const kidsIn = (dev) =>
    dev.sw.evaluate(async (title) => {
      const [folder] = (await chrome.bookmarks.search({ title })).filter((n) => !n.url);
      return folder ? (await chrome.bookmarks.getChildren(folder.id)).map((n) => n.url) : [];
    }, RESTORE_FOLDER);
  /** objectId the device's mapping table holds for a Chromium node. */
  const objectIdOf = (dev, chromiumId) =>
    dev.sw.evaluate(
      (id) =>
        new Promise((resolve, reject) => {
          const open = indexedDB.open("helixsync");
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const get = open.result.transaction("object_mappings").objectStore("object_mappings").get(`bookmark:${id}`);
            get.onsuccess = () => resolve(get.result?.objectId ?? null);
            get.onerror = () => reject(get.error);
          };
        }),
      chromiumId,
    );

  await a.sw.evaluate(
    async ({ title, urls }) => {
      globalThis.__removeInfo = undefined;
      chrome.bookmarks.onRemoved.addListener((id, info) => {
        globalThis.__removeInfo = { children: info.node?.children?.length ?? 0 };
      });
      const folder = await chrome.bookmarks.create({ parentId: "1", title });
      for (const [i, url] of urls.entries()) await chrome.bookmarks.create({ parentId: folder.id, title: `kid ${i + 1}`, url });
    },
    { title: RESTORE_FOLDER, urls: restoreKids },
  );
  check(
    "restore: a folder with children created in A reaches B",
    (await syncUntil([ca.popup, cb.popup], async () => (await kidsIn(b)).length === 2, 90_000)) === true,
  );

  const made = await ca.popup.evaluate(() => chrome.runtime.sendMessage({ type: "CREATE_RESTORE_POINT" }));
  check("restore: A creates a restore point", made?.ok === true && made.uploaded === true, JSON.stringify(made));
  const pointList = await ca.popup.evaluate(() => chrome.runtime.sendMessage({ type: "LIST_RESTORE_POINTS" }));
  const point = pointList?.points?.find((p) => p.id === made?.id);
  check("restore: the point is listed with the bookmark count", !!point && point.bookmarkCount >= 2, JSON.stringify(point));

  const [folderInA] = await folderIn(a);
  const objectIdBefore = folderInA ? await objectIdOf(a, folderInA.id) : null;
  if (folderInA) await a.sw.evaluate((id) => chrome.bookmarks.removeTree(id), folderInA.id);
  const removeInfo = await a.sw.evaluate(() => globalThis.__removeInfo);
  check("restore: onRemoved's node carries the removed folder's children", removeInfo?.children === 2, JSON.stringify(removeInfo));
  check(
    "restore: deleting the folder in A removes it from B",
    (await syncUntil([ca.popup, cb.popup], async () => (await folderIn(b)).length === 0, 90_000)) === true,
  );

  const started = await ca.popup.evaluate(
    (pointId) => chrome.runtime.sendMessage({ type: "START_RESTORE", pointId, mode: "merge", scope: "all" }),
    made?.id,
  );
  check("restore: A starts a merge restore", started?.ok === true, JSON.stringify(started));
  const finished = await waitFor(
    async () => {
      const reply = await ca.popup.evaluate(() => chrome.runtime.sendMessage({ type: "GET_RESTORE_PROGRESS" }));
      return reply?.progress?.phase === "done" || reply?.progress?.phase === "error" ? reply.progress : null;
    },
    { timeout: 60_000, interval: 500 },
  );
  check("restore: it finishes", finished?.phase === "done", JSON.stringify(finished));
  check("restore: A has the folder and children again", (await kidsIn(a)).sort().join() === [...restoreKids].sort().join());
  check(
    "restore: B gets the folder and its children back",
    (await syncUntil([ca.popup, cb.popup], async () => (await kidsIn(b)).length === 2, 90_000)) === true,
    (await kidsIn(b)).join(", "),
  );
  const [folderInB] = await folderIn(b);
  const [restoredInA] = await folderIn(a);
  const idA = restoredInA ? await objectIdOf(a, restoredInA.id) : null;
  const idB = folderInB ? await objectIdOf(b, folderInB.id) : null;
  check("restore: the folder has the same objectId on both devices, as before the delete", !!idA && idA === idB && idA === objectIdBefore, `${objectIdBefore} / ${idA} / ${idB}`);

  // Pinning a point.
  const pinned = await ca.popup.evaluate((pointId) => chrome.runtime.sendMessage({ type: "SET_RESTORE_POINT_PINNED", pointId, pinned: true }), made?.id);
  const listedPinned = (await ca.popup.evaluate(() => chrome.runtime.sendMessage({ type: "LIST_RESTORE_POINTS" })))?.points?.find((p) => p.id === made?.id);
  check("restore: a point can be pinned", pinned?.ok === true && listedPinned?.pinned === true, JSON.stringify(listedPinned));

  // Exact restore of one folder: the folder goes back to exactly what the
  // point holds, and nothing outside it changes.
  {
    const exactPoint = await ca.popup.evaluate(() => chrome.runtime.sendMessage({ type: "CREATE_RESTORE_POINT" }));
    const EXTRA_URL = `${BASE}/helixsync-e2e-kid-extra-${RUN}`;
    const OUTSIDE_URL = `https://example.com/helixsync-e2e-outside-${RUN}`;
    await a.sw.evaluate(
      async (args) => {
        const [folder] = (await chrome.bookmarks.search({ title: args.title })).filter((n) => !n.url);
        const [first] = await chrome.bookmarks.search({ url: args.remove });
        await chrome.bookmarks.remove(first.id);
        await chrome.bookmarks.create({ parentId: folder.id, title: "extra", url: args.extra });
        await chrome.bookmarks.create({ parentId: args.bar, title: "outside", url: args.outside });
      },
      { title: RESTORE_FOLDER, remove: restoreKids[0], extra: EXTRA_URL, bar: a.bar, outside: OUTSIDE_URL },
    );
    await syncUntil([ca.popup, cb.popup], async () => (await kidsIn(b)).includes(EXTRA_URL), 90_000);
    const [folderNow] = await folderIn(a);
    const scope = folderNow ? await objectIdOf(a, folderNow.id) : null;
    const startedExact = await ca.popup.evaluate(
      (args) => chrome.runtime.sendMessage({ type: "START_RESTORE", pointId: args.pointId, mode: "exact", scope: args.scope }),
      { pointId: exactPoint?.id, scope },
    );
    const doneExact = await waitFor(
      async () => {
        const reply = await ca.popup.evaluate(() => chrome.runtime.sendMessage({ type: "GET_RESTORE_PROGRESS" }));
        return reply?.progress?.phase === "done" || reply?.progress?.phase === "error" ? reply.progress : null;
      },
      { timeout: 60_000, interval: 500 },
    );
    check("restore (exact, one folder): it finishes", startedExact?.ok === true && doneExact?.phase === "done", JSON.stringify(doneExact ?? startedExact));
    check(
      "restore (exact, one folder): the folder holds exactly what the point holds",
      (await kidsIn(a)).sort().join() === [...restoreKids].sort().join(),
      (await kidsIn(a)).join(", "),
    );
    check("restore (exact, one folder): bookmarks outside the folder are kept", (await countByUrl(a, OUTSIDE_URL)) === 1);
    check(
      "restore (exact, one folder): B follows",
      (await syncUntil([ca.popup, cb.popup], async () => (await kidsIn(b)).sort().join() === [...restoreKids].sort().join(), 90_000)) === true,
      (await kidsIn(b)).join(", "),
    );
  }

  // A large deletion (50 or more bookmarks) makes an automatic point first.
  {
    const MASS_FOLDER = `Mass delete ${RUN}`;
    await a.sw.evaluate(
      async (args) => {
        const folder = await chrome.bookmarks.create({ parentId: args.bar, title: args.title });
        for (let i = 0; i < 55; i++) await chrome.bookmarks.create({ parentId: folder.id, title: `mass ${i}`, url: `https://example.com/mass-${args.run}-${i}` });
      },
      { bar: a.bar, title: MASS_FOLDER, run: RUN },
    );
    const massKidsIn = (dev) =>
      dev.sw.evaluate(async (title) => {
        const [folder] = (await chrome.bookmarks.search({ title })).filter((n) => !n.url);
        return folder ? (await chrome.bookmarks.getChildren(folder.id)).length : 0;
      }, MASS_FOLDER);
    await syncUntil([ca.popup, cb.popup], async () => (await massKidsIn(b)) === 55, 120_000);
    await a.sw.evaluate(async (title) => {
      const [folder] = (await chrome.bookmarks.search({ title })).filter((n) => !n.url);
      await chrome.bookmarks.removeTree(folder.id);
    }, MASS_FOLDER);
    const massPoint = await waitFor(
      async () => {
        await syncNow(ca.popup).catch(() => {});
        const list = await ca.popup.evaluate(() => chrome.runtime.sendMessage({ type: "LIST_RESTORE_POINTS" }));
        return list?.points?.find((p) => p.kind === "mass_delete" && p.deviceName === "E2E device A" && p.bookmarkCount >= 55) ?? null;
      },
      { timeout: 90_000, interval: 2_000 },
    );
    check("restore: deleting 55 bookmarks in A makes an automatic point that still holds them", !!massPoint, JSON.stringify(massPoint));
    check("restore: the large deletion reaches B", (await syncUntil([ca.popup, cb.popup], async () => (await massKidsIn(b)) === 0, 90_000)) === true);
  }

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

  // The popup's Restore points screen, clicked through as a user does, in B:
  // create, pin and unpin, restore one folder exactly (picker, preview,
  // confirm, progress, Done), and delete.
  {
    const UI_FOLDER = `UI restore ${RUN}`;
    const uiKids = [`https://example.com/ui-kid-1-${RUN}`, `https://example.com/ui-kid-2-${RUN}`];
    const UI_EXTRA = `https://example.com/ui-kid-extra-${RUN}`;
    const p = cb.popup;
    const uiKidsIn = (dev) =>
      dev.sw.evaluate(async (title) => {
        const [folder] = (await chrome.bookmarks.search({ title })).filter((n) => !n.url);
        return folder ? (await chrome.bookmarks.getChildren(folder.id)).map((n) => n.url).sort() : [];
      }, UI_FOLDER);
    await b.sw.evaluate(
      async (args) => {
        const folder = await chrome.bookmarks.create({ parentId: args.bar, title: args.title });
        for (const [i, url] of args.urls.entries()) await chrome.bookmarks.create({ parentId: folder.id, title: `ui ${i + 1}`, url });
      },
      { bar: b.bar, title: UI_FOLDER, urls: uiKids },
    );
    await syncUntil([cb.popup, ca.popup], async () => (await uiKidsIn(a)).length === 2, 90_000);

    const pointRows = () => p.locator("ul.restore-points li", { has: p.locator("button") });
    const openScreen = async () => {
      await p.reload();
      await p.waitForSelector(".status-card");
      await p.click("#open-restore-points");
      await p.getByRole("button", { name: "Create restore point", exact: true }).waitFor({ timeout: 30_000 });
    };
    await openScreen();
    const rowsBefore = await pointRows().count();
    await p.getByRole("button", { name: "Create restore point", exact: true }).click();
    const created = await waitFor(async () => ((await pointRows().count()) === rowsBefore + 1 ? true : null), { timeout: 30_000, interval: 500 });
    check("restore points screen: Create restore point adds one to the list", created === true, `${rowsBefore} -> ${await pointRows().count()}`);

    // The newest point is listed first.
    const newest = () => pointRows().first();
    await newest().getByRole("button", { name: "Pin", exact: true }).click();
    const pinnedShown = await waitFor(async () => ((await newest().textContent())?.includes("Pinned") ? true : null), { timeout: 15_000, interval: 300 });
    await newest().getByRole("button", { name: "Unpin", exact: true }).click();
    const unpinned = await waitFor(async () => ((await newest().textContent())?.includes("Pinned") ? null : true), { timeout: 15_000, interval: 300 });
    check("restore points screen: Pin marks the point pinned, Unpin clears it", pinnedShown === true && unpinned === true);

    // Change the folder after the point: remove one bookmark, add another.
    await b.sw.evaluate(
      async (args) => {
        const [folder] = (await chrome.bookmarks.search({ title: args.title })).filter((n) => !n.url);
        const [first] = await chrome.bookmarks.search({ url: args.remove });
        await chrome.bookmarks.remove(first.id);
        await chrome.bookmarks.create({ parentId: folder.id, title: "ui extra", url: args.extra });
      },
      { title: UI_FOLDER, remove: uiKids[0], extra: UI_EXTRA },
    );

    await newest().getByRole("button", { name: "Restore…", exact: true }).click();
    await p.getByRole("button", { name: "Preview", exact: true }).waitFor({ timeout: 30_000 });
    await p.locator("label.row", { hasText: "One folder" }).click();
    await p.getByRole("button", { name: UI_FOLDER, exact: true }).click();
    await p.locator("label.row", { hasText: "Exact:" }).click();
    await p.getByRole("button", { name: "Preview", exact: true }).click();
    const previewReady = await waitFor(
      async () =>
        p.evaluate(() => {
          const restore = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Restore");
          return restore && !restore.disabled ? document.querySelector(".status-message")?.textContent?.trim() || "ready" : null;
        }),
      { timeout: 30_000, interval: 300 },
    );
    check("restore points screen: picking one folder, Exact, and Preview lists the changes", !!previewReady, String(previewReady));
    await p.getByRole("button", { name: "Restore", exact: true }).click();
    await p.click("#modal-confirm");
    const finished = await waitFor(
      async () => ((await p.evaluate(() => document.querySelector(".view-subtitle")?.textContent?.trim())) === "Done." ? true : null),
      { timeout: 60_000, interval: 500 },
    );
    check("restore points screen: Restore runs to Done.", finished === true);
    check("restore points screen: the folder is back to exactly the point", (await uiKidsIn(b)).join() === [...uiKids].sort().join(), (await uiKidsIn(b)).join(", "));
    await p.getByRole("button", { name: "Done", exact: true }).click();
    const backToList = await p.getByRole("button", { name: "Create restore point", exact: true }).waitFor({ timeout: 15_000 }).then(() => true, () => false);
    check("restore points screen: Done goes back to the list", backToList);
    await openScreen().catch(() => {});
    check("restore points screen: reopening it shows the list, not the finished restore", (await p.getByRole("button", { name: "Create restore point", exact: true }).count()) > 0);
    check(
      "restore points screen: A follows the restore",
      (await syncUntil([cb.popup, ca.popup], async () => (await uiKidsIn(a)).join() === [...uiKids].sort().join(), 90_000)) === true,
      (await uiKidsIn(a)).join(", "),
    );

    const rowsBeforeDelete = await pointRows().count();
    await newest().getByRole("button", { name: "Delete", exact: true }).click();
    await p.click("#modal-confirm");
    const deleted = await waitFor(async () => ((await pointRows().count()) === rowsBeforeDelete - 1 ? true : null), { timeout: 30_000, interval: 500 });
    check("restore points screen: Delete removes the point", deleted === true, `${rowsBeforeDelete} -> ${await pointRows().count()}`);
    await p.reload();
    await p.waitForSelector(".status-card");
  }

  // History retention: widening it offers "Sync older history" once.
  {
    const saved = await saveSettings(ca.popup, { historyRetention: "unlimited" });
    check("settings: history retention is 30 days by default", saved.formBefore.historyRetention === "30d", JSON.stringify(saved.formBefore));
    const offer = ca.popup.locator("#sync-older-history");
    const offered = await offer.waitFor({ timeout: 15_000 }).then(() => true, () => false);
    check("history: widening the retention offers \"Sync older history\"", offered);
    if (offered) await offer.click();
    const started = await ca.popup.getByText("Importing older history in the background.").waitFor({ timeout: 30_000 }).then(() => true, () => false);
    check("history: \"Sync older history\" starts the import", started);
    await ca.popup.reload();
    await ca.popup.waitForSelector(".status-card");
    check("history: the offer is shown only once", (await ca.popup.locator("#sync-older-history").count()) === 0);
  }

  // Interface language: switching it redraws the popup; Arabic is right to left.
  for (const [label, dev, popup] of [["A", a, ca.popup], ["B", b, cb.popup]]) {
    await popup.click("#open-settings");
    await popup.waitForSelector("#uiLanguage");
    await popup.selectOption("#uiLanguage", "de");
    const german = await waitFor(async () => (await popup.evaluate(() => document.documentElement.lang)) === "de", { timeout: 10_000, interval: 250 });
    await popup.waitForSelector("#uiLanguage");
    await popup.selectOption("#uiLanguage", "ar");
    const arabic = await waitFor(
      async () => (await popup.evaluate(() => [document.documentElement.lang, document.documentElement.dir].join())) === "ar,rtl",
      { timeout: 10_000, interval: 250 },
    );
    await popup.waitForSelector("#uiLanguage");
    await popup.selectOption("#uiLanguage", "en");
    const english = await waitFor(
      async () => (await popup.evaluate(() => [document.documentElement.lang, document.documentElement.dir].join())) === "en,ltr",
      { timeout: 10_000, interval: 250 },
    );
    check(`language (${label}, ${dev.kind}): German, Arabic right to left, and back to English`, german === true && arabic === true && english === true);
    await popup.reload();
    await popup.waitForSelector(".status-card");
  }

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

  // "Restore all" opens every offered tab.
  {
    const ALL_URLS = [`${BASE}/helixsync-e2e-all-1-${RUN}`, `${BASE}/helixsync-e2e-all-2-${RUN}`];
    const pages = [];
    for (const url of ALL_URLS) pages.push(await openPage(a, url, "page"));
    await syncUntil([ca.popup, cb.popup], async () => {
      const offeredNow = await pendingRestores(cb.popup);
      return ALL_URLS.every((u) => offeredNow.includes(u));
    }, 90_000);
    await cb.popup.getByRole("button", { name: "Restore all" }).click();
    const allOpened = await waitFor(async () => {
      for (const url of ALL_URLS) if ((await tabsAt(b, url)).length !== 1) return false;
      return true;
    }, { timeout: 30_000 });
    check("tabs (ask): \"Restore all\" opens every offered tab once in B", allOpened === true);
    for (const p of pages) await p.close();
  }

  // "Automatic": a grouped tab opened in A opens in B, in a matching group.
  await saveSettings(cb.popup, { tabRestorePolicy: "automatic" });
  await a.sw.evaluate(async (url) => {
    const tab = await chrome.tabs.create({ url, active: false });
    const groupId = await chrome.tabs.group({ tabIds: tab.id });
    await chrome.tabGroups.update(groupId, { title: "E2E group", color: "purple" });
  }, GROUPED_TAB_URL);
  const grouped = await syncUntil([ca.popup, cb.popup], async () => {
    const tabs = await tabsAt(b, GROUPED_TAB_URL);
    return tabs.length === 1 && tabs[0].group?.title === "E2E group" && tabs[0].group.color === "purple";
  }, 90_000);
  check("tab groups (automatic): a grouped tab in A opens once in B, in a group with the same title and color", grouped === true, JSON.stringify(await tabsAt(b, GROUPED_TAB_URL)));

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

  // A tab opened in B opens in A. The policy is account-wide, but each device
  // caches it for up to 30 minutes (api/client.ts), so A saves it too.
  await saveSettings(ca.popup, { tabRestorePolicy: "automatic" });
  const tabPageB = await openPage(b, TAB_URL_B, "page");
  const openedInA = await syncUntil([cb.popup, ca.popup], async () => (await tabsAt(a, TAB_URL_B)).length === 1, 90_000);
  check("tabs (automatic): a tab opened in B opens in A", openedInA === true);
  await tabPageB.close();

  // A tab opened in a new window in A opens in B.
  {
    const WINDOW_URL = `${BASE}/helixsync-e2e-window-${RUN}`;
    await a.sw.evaluate((url) => chrome.windows.create({ url, focused: false }), WINDOW_URL);
    check(
      "tabs (automatic): a tab in a new window in A opens once in B",
      (await syncUntil([ca.popup, cb.popup], async () => (await tabsAt(b, WINDOW_URL)).length === 1, 90_000)) === true,
      `${(await tabsAt(b, WINDOW_URL)).length} in B`,
    );
  }
  await tabPage.close();

  // Passkey-sealed recovery code (docs/encryption.md §9.5), with Chromium's
  // virtual authenticator standing in for a real one (it supports PRF).
  {
    const sec = await openPage(a, `${BASE}/security`, "dashboard");
    const cdp = await a.ctx.newCDPSession(sec);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        hasPrf: true,
        automaticPresenceSimulation: true,
      },
    });
    await sec.getByLabel("Type your current recovery code").fill(RECOVERY_CODE);
    await sec.getByRole("button", { name: "Add a passkey" }).click();
    const added = await sec.getByText("Passkey added.").waitFor({ timeout: 30_000 }).then(() => true, () => false);
    check("passkey: a passkey seals the recovery code", added);
    await sec.getByRole("button", { name: "Check it still works" }).click();
    const works = await sec.getByText("Your passkey opens your current recovery code.").waitFor({ timeout: 30_000 }).then(() => true, () => false);
    check("passkey: it unseals to the current recovery code", works);
    await sec.close();
  }

  // Two-device password reset (docs/encryption.md §9.4): two different
  // connected extensions approve, the second hands over the account key.
  {
    const NEW_PASSWORD = randomBytes(18).toString("base64url");
    const reset = await openPage(a, `${BASE}/reset`, "dashboard");
    await reset.fill('input[type="email"]', EMAIL);
    await reset.getByRole("button", { name: "Ask my browsers" }).click();
    await reset.locator("code").waitFor({ timeout: 30_000 });
    const requestPhrase = (await reset.locator("code").textContent())?.trim();

    const resetCard = async (dev) => {
      return waitFor(async () => {
        await dev.popup.reload();
        const card = dev.popup.locator(".auth-request.password-reset");
        return (await card.first().waitFor({ timeout: 15_000 }).then(() => true, () => false)) ? card.first() : null;
      }, { timeout: 60_000, interval: 500 });
    };

    const cardA = await resetCard(ca);
    const shownA = cardA ? (await cardA.locator(".fingerprint").first().textContent())?.trim() : undefined;
    check("reset: A shows the request with the same phrase", !!requestPhrase && requestPhrase === shownA, `${requestPhrase} / ${shownA}`);
    check("reset: the first approval carries no key phrase", cardA ? (await cardA.locator(".fingerprint").count()) === 1 : false);
    if (cardA) await cardA.getByRole("button", { name: "Approve" }).click();

    const cardB = await resetCard(cb);
    const keyPhrase = cardB && (await cardB.locator(".fingerprint").count()) === 2
      ? (await cardB.locator(".fingerprint").nth(1).textContent())?.trim()
      : undefined;
    check("reset: B asks as the second approver and shows the key check phrase", !!keyPhrase, keyPhrase ?? "");
    if (cardB) await cardB.getByRole("button", { name: "Approve" }).click();

    const approvedOk = await reset.getByText("Two of your browsers approved").waitFor({ timeout: 60_000 }).then(() => true, () => false);
    check("reset: the dashboard sees two approvals", approvedOk);
    const pagePhrase = approvedOk ? (await reset.locator("code").first().textContent())?.trim() : undefined;
    check("reset: the dashboard's key check phrase equals B's", !!keyPhrase && keyPhrase === pagePhrase, `${keyPhrase} / ${pagePhrase}`);

    await reset.getByLabel("The phrase matches the one in the extension.").check();
    await reset.getByLabel("New password", { exact: true }).fill(NEW_PASSWORD);
    await reset.getByLabel("Confirm new password").fill(NEW_PASSWORD);
    await reset.getByRole("button", { name: "Reset password" }).click();
    // The new code's screen is the one with the type-it-back field.
    const typeBack = reset.locator('input[placeholder^="XXXX-"]');
    const gotCode = await typeBack.waitFor({ timeout: 60_000 }).then(() => true, () => false);
    const newCode = gotCode ? (await reset.locator("code").first().innerText()).trim() : "";
    check("reset: a new recovery code is shown", /^[0-9A-Z]{4}(-[0-9A-Z]{4}){7}$/.test(newCode), newCode ? "shown" : "");
    await typeBack.fill(newCode);
    await reset.getByRole("button", { name: "Sign in" }).click();
    await reset.waitForURL(`${BASE}/login`, { timeout: 30_000 }).catch(() => {});

    // The new password works and the old one no longer does.
    const loginWith = async (password) => {
      await reset.goto(`${BASE}/login`);
      await reset.fill('input[type="email"]', EMAIL);
      await reset.fill('input[type="password"]', password);
      await reset.getByRole("button", { name: "Sign in", exact: true }).first().click();
      await reset.waitForURL(`${BASE}/`, { timeout: 15_000 }).catch(() => {});
      return reset.url() === `${BASE}/`;
    };
    check("reset: the old password no longer signs in", (await loginWith(PASSWORD)) === false);
    check("reset: the new password signs in", (await loginWith(NEW_PASSWORD)) === true);
    await reset.close();
    CURRENT_PASSWORD = NEW_PASSWORD;
    if (newCode) RECOVERY_CODE = newCode;
  }

  /** True once a bookmark A makes reaches B: sync still works. */
  const stillSyncs = async (tag) => {
    const url = `https://example.com/helixsync-e2e-still-${tag}-${RUN}`;
    await a.sw.evaluate((args) => chrome.bookmarks.create({ parentId: args.bar, title: args.tag, url: args.url }), { bar: a.bar, tag, url });
    return (await syncUntil([ca.popup, cb.popup], async () => (await countByUrl(b, url)) === 1, 90_000)) === true;
  };
  check("reset: both extensions keep syncing after the password reset", await stillSyncs("after-reset"));

  // Dashboard: change the password.
  {
    const CHANGED = randomBytes(18).toString("base64url");
    const sec = await dashboardPage("/security");
    await sec.getByLabel("Current password").fill(CURRENT_PASSWORD);
    await sec.getByLabel("New password", { exact: true }).fill(CHANGED);
    await sec.getByRole("button", { name: "Update password" }).click();
    const updated = await sec.getByText("Password updated.").waitFor({ timeout: 30_000 }).then(() => true, () => false);
    check("dashboard: password change", updated);
    if (updated) CURRENT_PASSWORD = CHANGED;
    await sec.close();
    check("dashboard: both extensions keep syncing after a password change", await stillSyncs("after-change"));
  }

  // Dashboard: forgotten password, reset with the recovery code.
  {
    const RECOVERED = randomBytes(18).toString("base64url");
    const rec = await openPage(a, `${BASE}/recover`, "dashboard");
    await rec.getByLabel("Email").fill(EMAIL);
    await rec.getByLabel("Recovery code").fill(RECOVERY_CODE);
    await rec.getByLabel("New password", { exact: true }).fill(RECOVERED);
    await rec.getByLabel("Confirm new password").fill(RECOVERED);
    await rec.getByRole("button", { name: "Reset password" }).click();
    const typeBack = rec.locator('input[placeholder^="XXXX-"]');
    const gotCode = await typeBack.waitFor({ timeout: 60_000 }).then(() => true, () => false);
    const code = gotCode ? (await rec.locator("code").first().innerText()).trim() : "";
    check("recover: the recovery code resets the password and shows a new code", /^[0-9A-Z]{4}(-[0-9A-Z]{4}){7}$/.test(code));
    if (gotCode) {
      await typeBack.fill(code);
      await rec.getByRole("button", { name: "Sign in" }).click();
      RECOVERY_CODE = code;
      CURRENT_PASSWORD = RECOVERED;
    }
    await rec.close();
    const signedIn = await dashboardPage("/");
    check("recover: the new password signs in", new URL(signedIn.url()).pathname === "/", signedIn.url());
    await signedIn.close();
    check("recover: both extensions keep syncing after the recovery", await stillSyncs("after-recover"));
  }

  // Dashboard: rename a device.
  {
    const devPage = await dashboardPage("/devices");
    await devPage.getByRole("button", { name: "E2E device A", exact: true }).click();
    const input = devPage.locator("td input");
    await input.fill("E2E device A renamed");
    await input.press("Enter");
    const renamed = await devPage.getByRole("button", { name: "E2E device A renamed", exact: true }).waitFor({ timeout: 15_000 }).then(() => true, () => false);
    const names = (await listDevices(devPage)).map((d) => d.name);
    check("dashboard: rename a device", renamed && names.includes("E2E device A renamed"), names.join(", "));
    await devPage.close();
  }

  // Dashboard: sync settings reach the extensions.
  {
    const syncPage = await dashboardPage("/sync");
    const retention = syncPage.locator("select", { has: syncPage.locator('option[value="90d"]') });
    await retention.selectOption("90d");
    await syncPage.waitForTimeout(1_000);
    await syncPage.close();
    const form = await saveSettings(ca.popup, {});
    check("dashboard: a sync setting changed there shows in the extension", form.formBefore.historyRetention === "90d", JSON.stringify(form.formBefore));
  }

  // Dashboard: restore points page lists the pinned point; deleting one there
  // removes it for the extension too.
  {
    const rp = await dashboardPage("/restore-points");
    const pinnedShown = await rp.getByText("Pinned").first().waitFor({ timeout: 15_000 }).then(() => true, () => false);
    check("dashboard: restore points page lists the points, pinned one marked", pinnedShown);
    const before = (await ca.popup.evaluate(() => chrome.runtime.sendMessage({ type: "LIST_RESTORE_POINTS" })))?.points ?? [];
    const target = before.find((p) => !p.pinned);
    const rows = rp.locator("tbody tr");
    const rowCount = await rows.count();
    let deleted = false;
    for (let i = 0; i < rowCount && target; i++) {
      const row = rows.nth(i);
      if ((await row.getByRole("button", { name: "Unpin" }).count()) > 0) continue;
      await row.getByRole("button", { name: "Delete" }).click();
      deleted = true;
      break;
    }
    const after = deleted
      ? await waitFor(async () => {
          const list = (await ca.popup.evaluate(() => chrome.runtime.sendMessage({ type: "LIST_RESTORE_POINTS" })))?.points ?? [];
          return list.length === before.length - 1 ? list : null;
        }, { timeout: 30_000 })
      : null;
    check("dashboard: deleting a restore point there removes it", !!after, `${before.length} -> ${after?.length}`);
    await rp.close();
  }

  // Disconnect B from its popup: the server revokes the device.
  await cb.popup.reload();
  await cb.popup.click("#open-settings");
  await cb.popup.click("#disconnect");
  await cb.popup.click("#modal-confirm");
  const backToSetup = await cb.popup.waitForSelector("#setup-form", { timeout: 30_000 }).then(() => true, () => false);
  const bRow = (await listDevices(dash)).find((d) => d.name === "E2E device B");
  check("extension B: Disconnect revokes the device", backToSetup && !!bRow?.revokedAt);

  // Reconnect B by approval from A (no password), with B still holding all
  // the account's bookmarks: nothing gets duplicated.
  {
    await cb.popup.fill("#serverUrl", BASE);
    await cb.popup.fill("#email", EMAIL);
    await cb.popup.fill("#deviceName", "E2E device B again");
    await cb.popup.click("#device-login");
    await cb.popup.waitForSelector("#fingerprint", { timeout: 30_000 });
    const phraseB = await waitFor(async () => (await cb.popup.textContent("#fingerprint"))?.trim() || null, { timeout: 15_000, interval: 250 });
    const card = await waitFor(async () => {
      await ca.popup.reload();
      const c = ca.popup.locator(".auth-request");
      return (await c.first().waitFor({ timeout: 15_000 }).then(() => true, () => false)) ? c.first() : null;
    }, { timeout: 60_000, interval: 500 });
    const shownA = card ? (await card.locator(".fingerprint").first().textContent())?.trim() : undefined;
    check("connect by approval: A shows B's request with the same phrase", !!phraseB && phraseB === shownA, `${phraseB} / ${shownA}`);
    // A shows the account key's check phrase; B shows it after the approval
    // and the user continues only if the two match.
    const keyPhraseA = card && (await card.locator(".fingerprint").count()) === 2 ? (await card.locator(".fingerprint").nth(1).textContent())?.trim() : undefined;
    if (card) await card.getByRole("button", { name: "Approve" }).click();
    await cb.popup.waitForSelector("#key-check", { timeout: 60_000 }).catch(() => {});
    const keyPhraseB = (await cb.popup.textContent("#key-check").catch(() => ""))?.trim();
    check("connect by approval: B's key check phrase equals the one A shows", !!keyPhraseA && keyPhraseA === keyPhraseB, `${keyPhraseA} / ${keyPhraseB}`);
    await cb.popup.click("#key-check-match");
    const reconnected = await cb.popup.waitForSelector(".status-card", { timeout: 90_000 }).then(() => true, () => false);
    check("connect by approval: B connects without its password", reconnected);
    const urls = [ASLEEP_BOOKMARK_URL, ...restoreKids];
    const noDupes = await syncUntil([ca.popup, cb.popup], async () => {
      for (const url of urls) {
        if ((await countByUrl(a, url)) !== 1 || (await countByUrl(b, url)) !== 1) return false;
      }
      return true;
    }, 60_000);
    const counts = [];
    for (const url of urls) counts.push(`${await countByUrl(a, url)}/${await countByUrl(b, url)}`);
    check("connect by approval: reconnecting B duplicates nothing on either device", noDupes === true, counts.join(" "));
    check("connect by approval: B syncs again", await stillSyncs("after-reconnect"));
  }

  // Login with device: B's browser signs in to the dashboard, approved from A.
  const login = await openPage(b, `${BASE}/login`, "dashboard");
  await login.fill('input[type="email"]', EMAIL);
  await login.getByRole("button", { name: "Log in with a device" }).click();
  await login.locator("code").waitFor({ timeout: 30_000 });
  const phrase = (await login.locator("code").textContent())?.trim();
  // The popup renders only after the service worker answers its status
  // request, which can take seconds while the worker is busy syncing. Reload,
  // then give that render time to finish instead of reloading it away.
  const request = await waitFor(async () => {
    await ca.popup.reload();
    const card = ca.popup.locator(".auth-request");
    return (await card.first().waitFor({ timeout: 15_000 }).then(() => true, () => false)) ? card.first() : null;
  }, { timeout: 60_000, interval: 500 });
  const shown = request ? (await request.locator(".fingerprint").first().textContent())?.trim() : undefined;
  check("login with device: A shows the request with the same phrase", !!phrase && phrase === shown, `${phrase} / ${shown}`);
  if (request) await request.getByRole("button", { name: "Approve" }).click();
  await login.waitForURL(`${BASE}/`, { timeout: 30_000 }).catch(() => {});
  const me = await login.evaluate(() => fetch("/api/v1/auth/me").then((r) => r.status));
  check("login with device: B's dashboard is signed in", login.url() === `${BASE}/` && me === 200, `/me ${me}`);

  // Dashboard: revoke B's web session from A's Security page.
  {
    const sec = await dashboardPage("/security");
    // Only other sessions have a Revoke button (this one is marked instead).
    await sec.getByText("(this session)").waitFor({ timeout: 15_000 });
    const revokeButtons = sec.getByRole("button", { name: "Revoke", exact: true });
    let revoked = false;
    for (let i = 0; i < 10 && (await revokeButtons.count()) > 0; i++) {
      await revokeButtons.first().click();
      revoked = true;
      await sec.waitForTimeout(500);
    }
    const meAfter = await waitFor(async () => {
      const status = await login.evaluate(() => fetch("/api/v1/auth/me").then((r) => r.status));
      return status === 401 ? status : null;
    }, { timeout: 30_000 });
    check("dashboard: revoking another web session signs it out", revoked && meAfter === 401, `/me ${meAfter}`);
    await sec.close();
  }

  // Dashboard: revoke device B; B's extension stops syncing and says so.
  {
    const devPage = await dashboardPage("/devices");
    const row = devPage.locator("tr", { has: devPage.getByRole("button", { name: "E2E device B again", exact: true }) });
    await row.getByRole("button", { name: "Revoke" }).click();
    const gone = await waitFor(async () => (await listDevices(devPage)).find((d) => d.name === "E2E device B again")?.revokedAt ?? null, { timeout: 30_000 });
    await devPage.close();
    const shown = await waitFor(async () => {
      await syncNow(cb.popup).catch(() => {});
      await cb.popup.reload();
      return cb.popup.locator("#setup-form, .status-card").first().waitFor({ timeout: 10_000 }).then(async () => {
        if ((await cb.popup.locator("#setup-form").count()) > 0) return "setup";
        const text = (await cb.popup.textContent(".status-card"))?.replace(/\s+/g, " ").trim() ?? "";
        return /^Synced|^Syncing/.test(text) ? null : text;
      }, () => null);
    }, { timeout: 60_000, interval: 1_000 });
    check("dashboard: revoking a device stops it, and its popup says so", !!gone && !!shown, `${gone ? "revoked" : "not revoked"}, popup: ${shown}`);
  }

  // Dashboard: delete the account. A's extension stops and says so.
  {
    const sec = await dashboardPage("/security");
    const danger = sec.locator("section, div", { has: sec.getByText("Danger zone") }).last();
    await danger.getByLabel("Your password").fill(CURRENT_PASSWORD);
    await danger.locator('input[type="text"]').fill("DELETE");
    await danger.getByRole("button", { name: "Delete my account" }).click();
    await sec.waitForURL(`${BASE}/login`, { timeout: 30_000 }).catch(() => {});
    check("dashboard: delete the account", new URL(sec.url()).pathname === "/login", sec.url());
    const signIn = await sec.evaluate(
      (args) => fetch("/api/v1/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args) }).then((r) => r.status),
      { email: EMAIL, password: CURRENT_PASSWORD },
    );
    check("dashboard: the deleted account can't sign in", signIn >= 400, `login ${signIn}`);
    await sec.close();
    const shownA = await waitFor(async () => {
      await syncNow(ca.popup).catch(() => {});
      await ca.popup.reload();
      return ca.popup.locator("#setup-form, .status-card").first().waitFor({ timeout: 10_000 }).then(async () => {
        if ((await ca.popup.locator("#setup-form").count()) > 0) return "setup";
        const text = (await ca.popup.textContent(".status-card"))?.replace(/\s+/g, " ").trim() ?? "";
        return /^Synced|^Syncing/.test(text) ? null : text;
      }, () => null);
    }, { timeout: 60_000, interval: 1_000 });
    check("dashboard: after the account is deleted, A's popup says it is no longer connected", !!shownA, String(shownA));
  }
} catch (e) {
  check("test ran to completion", false, e.message.split("\n")[0]);
} finally {
  for (const d of devices) await d.ctx.close().catch(() => {});
  stopFirefoxLog();
}

// The extension must run without errors or warnings: every one its worker,
// background page or popup logged (or threw) during the run fails this.
// Website pages (the dashboard, test pages) aren't the extension's.
const extensionProblems = readFileSync(LOG, "utf8")
  .split("\n")
  .filter((line) => /^\[[AB] (worker|background|popup|api) (error|warn|warning|pageerror|unhandledrejection)\]/.test(line))
  // Chromium's own line for any HTTP error response (a 401 before a token
  // refresh, or once the account is gone), not something the extension logs.
  .filter((line) => !/\] Failed to load resource: the server responded with a status of 401 /.test(line));
check(
  "extension: no errors or warnings in its console",
  extensionProblems.length === 0,
  extensionProblems.length ? `${extensionProblems.length}:\n    ${[...new Set(extensionProblems)].slice(0, 40).join("\n    ")}` : "",
);

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
if (failed) {
  console.log(`Browser console output and profiles kept in ${WORK}`);
} else {
  rmSync(WORK, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
