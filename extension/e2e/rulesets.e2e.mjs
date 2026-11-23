// End-to-end test of selective-sync rulesets (docs/protocol.md §17) with the
// built extension (dist/) in two Chromium profiles, against a local stack.
//
// A connects first and syncs two folders. On the dashboard (A's browser) the
// Default ruleset gets "don't sync folder Personal" (picked from the Vault's
// decrypted folders) and an address pattern. B, which already has a local
// folder of the same name, then connects and joins Default; it is also put in
// a second ruleset, Social, that blocks a domain. The test checks what B
// receives and uploads, that history is filtered, the dashboard's per-device
// test, and that lifting the folder rule merges both folders without a copy.
//
//   HELIXSYNC_E2E_BROWSER    Chromium-based browser (required)
//   HELIXSYNC_E2E_URL        the stack's dashboard origin (default http://localhost:5173)
import { chromium } from "playwright-core";
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { randomBytes } from "crypto";

const BASE = (process.env.HELIXSYNC_E2E_URL ?? "http://localhost:5173").replace(/\/$/, "");
const BROWSER = process.env.HELIXSYNC_E2E_BROWSER;
const DIST = resolve(import.meta.dirname, "../dist");

if (!BROWSER) {
  console.error("Set HELIXSYNC_E2E_BROWSER to a Chromium-based browser, e.g. /usr/bin/chromium.");
  process.exit(2);
}
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(BASE).hostname)) {
  console.error(`HELIXSYNC_E2E_URL must be a local address, got ${BASE}.`);
  process.exit(2);
}
if (!existsSync(join(DIST, "manifest.json"))) {
  console.error("Build the extension first: npm run build");
  process.exit(2);
}

const WORK = mkdtempSync(join(tmpdir(), "helixsync-rulesets-e2e-"));
const LOG = join(WORK, "console.log");
writeFileSync(LOG, "");

// Same manifest tweak as sync.e2e.mjs: an automated browser can't click the
// host permission prompt.
const EXT = join(WORK, "extension");
cpSync(DIST, EXT, { recursive: true });
const manifest = JSON.parse(readFileSync(join(EXT, "manifest.json"), "utf8"));
const origin = new URL(BASE);
manifest.host_permissions = [`${origin.origin}/*`, `ws://${origin.host}/*`];
writeFileSync(join(EXT, "manifest.json"), JSON.stringify(manifest, null, 2));

const EMAIL = `e2e-rulesets-${Date.now()}@example.test`;
const PASSWORD = randomBytes(18).toString("base64url");
const RUN = Date.now().toString(36);
const PERSONAL = `Personal ${RUN}`;
const WORK_FOLDER = `Work ${RUN}`;
const P_URL = `https://example.com/rs-personal-a-${RUN}`; // A's, in Personal
const PB_URL = `https://example.com/rs-personal-b-${RUN}`; // B's own, in its local Personal
const W_URL = `https://example.com/rs-work-${RUN}`;
const PATTERN = `rs-blocked-pattern-${RUN}`;
const PATTERN_URL = `${BASE}/${PATTERN}`;
const DOMAIN_URL = `http://127.0.0.1:${origin.port || 80}/rs-domain-${RUN}`;
const ALLOWED_URL = `${BASE}/rs-allowed-${RUN}`;
const OTHER = "2"; // Other bookmarks

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

async function launch(label) {
  const profile = mkdtempSync(join(WORK, `profile-${label}-`));
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath: BROWSER,
    headless: false,
    viewport: { width: 1200, height: 900 },
    args: ["--headless=new", "--lang=en-US", `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-first-run", "--no-default-browser-check"],
  });
  const dev = { label, ctx };
  const watch = (sw) => sw.on("console", (m) => appendFileSync(LOG, `[${label} worker ${m.type()}] ${m.text()}\n`));
  dev.sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker", { timeout: 15_000 }));
  watch(dev.sw);
  ctx.on("serviceworker", (next) => {
    watch(next);
    dev.sw = next;
  });
  dev.extensionOrigin = `chrome-extension://${new URL(dev.sw.url()).host}`;
  return dev;
}

async function openPage(dev, url, kind) {
  const page = await dev.ctx.newPage();
  page.on("console", (m) => appendFileSync(LOG, `[${dev.label} ${kind} ${m.type()}] ${m.text()}\n`));
  page.on("pageerror", (e) => appendFileSync(LOG, `[${dev.label} ${kind} pageerror] ${e.message}\n`));
  page.on("dialog", (d) => d.accept().catch(() => {}));
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
async function syncUntil(popups, predicate, timeout = 90_000) {
  return waitFor(async () => {
    for (const p of popups) await syncNow(p).catch(() => {});
    return predicate();
  }, { timeout });
}
const countUrl = (dev, url) => dev.sw.evaluate((url) => chrome.bookmarks.search({ url }).then((r) => r.length), url);
const foldersTitled = (dev, title) =>
  dev.sw.evaluate((title) => chrome.bookmarks.search({ title }).then((r) => r.filter((n) => !n.url)), title);
const inHistory = (dev, url) =>
  dev.sw.evaluate((url) => chrome.history.search({ text: url, startTime: 0, maxResults: 20 }).then((r) => r.some((i) => i.url === url)), url);
async function makeFolder(dev, title, bookmarkUrl) {
  return dev.sw.evaluate(
    async ({ title, bookmarkUrl, parentId }) => {
      const folder = await chrome.bookmarks.create({ parentId, title });
      await chrome.bookmarks.create({ parentId: folder.id, title: "e2e", url: bookmarkUrl });
      return folder.id;
    },
    { title, bookmarkUrl, parentId: OTHER },
  );
}

// --- Dashboard helpers (A's browser) ---
async function openRulesets(page) {
  await page.goto(`${BASE}/rulesets`);
  await page.waitForLoadState("networkidle").catch(() => {});
  const unlock = page.locator("#vault-password");
  if (await unlock.isVisible().catch(() => false)) {
    await unlock.fill(PASSWORD);
    await page.getByRole("button", { name: "Unlock", exact: true }).click();
  }
  await page.getByRole("button", { name: "New ruleset" }).waitFor({ timeout: 60_000 });
}
const addRuleKind = (page, kind) => page.locator('select[aria-label="Add a rule"]').selectOption(kind);
async function saveRules(page, button = "Save") {
  await page.getByRole("button", { name: button, exact: true }).click();
  return page.getByText("Saved.", { exact: true }).waitFor({ timeout: 30_000 }).then(() => true, () => false);
}

const devices = [];
try {
  const a = await launch("A");
  const b = await launch("B");
  devices.push(a, b);
  console.log(`server ${BASE}, browser ${BROWSER}`);

  // B's own folder named like A's, made before B connects.
  await makeFolder(b, PERSONAL, PB_URL);

  // Register in A's browser.
  const dash = await openPage(a, `${BASE}/login?mode=register`, "dashboard");
  await dash.fill('input[type="email"]', EMAIL);
  const passwords = dash.locator('input[type="password"]');
  await passwords.nth(0).fill(PASSWORD);
  await passwords.nth(1).fill(PASSWORD);
  await dash.locator('form input[type="checkbox"]').check();
  await dash.getByRole("button", { name: "Create account" }).click();
  const codeBox = dash.locator("code").first();
  await codeBox.waitFor({ timeout: 60_000 });
  await dash.locator('input[placeholder^="XXXX-"]').fill((await codeBox.innerText()).trim());
  await dash.getByRole("button", { name: "Continue to HelixSync" }).click();
  await dash.waitForURL(`${BASE}/`, { timeout: 30_000 }).catch(() => {});
  check("setup: account registered", dash.url() === `${BASE}/`, dash.url());

  // A connects and syncs Personal and Work.
  const ca = await connect(a, "E2E device A");
  check("setup: A connects", ca.connected === true, ca.connected === true ? "" : ca.connected);
  await makeFolder(a, PERSONAL, P_URL);
  await makeFolder(a, WORK_FOLDER, W_URL);

  // Dashboard: the Default ruleset gets the folder rule and a pattern.
  await openRulesets(dash);
  check("dashboard: Default ruleset is listed first", (await dash.locator("ul button[aria-pressed]").first().innerText()).includes("Default"));
  await addRuleKind(dash, "excludeFolder");
  const search = dash.getByLabel("Search folders");
  // The Vault shows A's folders once A's upload reached the server.
  const pickerReady = await waitFor(async () => {
    if (!(await search.isVisible().catch(() => false))) {
      await syncNow(ca.popup).catch(() => {});
      await openRulesets(dash);
      await addRuleKind(dash, "excludeFolder");
      return false;
    }
    await search.fill(RUN);
    const labels = await dash.locator("ul li span[title]").allInnerTexts();
    if (labels.some((l) => l.includes(PERSONAL)) && labels.some((l) => l.includes(WORK_FOLDER))) return labels;
    await syncNow(ca.popup).catch(() => {});
    await openRulesets(dash);
    await addRuleKind(dash, "excludeFolder");
    return false;
  }, { timeout: 120_000, interval: 3_000 });
  check("folder picker: lists the folders synced from A", !!pickerReady, Array.isArray(pickerReady) ? pickerReady.join(" | ") : "");
  await dash.locator("li", { hasText: PERSONAL }).getByRole("button", { name: "Don't sync" }).click();
  check("dashboard: the folder rule is added", await dash.getByText(`Don't sync folder:`).first().isVisible());
  await addRuleKind(dash, "blockPattern");
  await dash.getByLabel("Regular expression, tested against the full address").fill(PATTERN);
  await dash.getByRole("button", { name: "Add", exact: true }).click();
  check("dashboard: Default ruleset saves", await saveRules(dash));

  // B connects: it joins Default, which already has rules.
  const cb = await connect(b, "E2E device B");
  check("setup: B connects", cb.connected === true, cb.connected === true ? "" : cb.connected);

  const workArrived = await syncUntil([ca.popup, cb.popup], async () => (await countUrl(b, W_URL)) === 1, 120_000);
  check("bookmarks: B receives the folder no rule excludes", workArrived === true);
  check("bookmarks: B does not receive A's excluded folder's contents", (await countUrl(b, P_URL)) === 0);
  // Give B's first import time to upload whatever it would.
  await syncUntil([cb.popup, ca.popup], async () => false, 20_000);
  check("bookmarks: B's own copy of the excluded folder is not uploaded", (await countUrl(a, PB_URL)) === 0, `A has ${await countUrl(a, PB_URL)}`);
  check("bookmarks: B's own excluded folder stays on B", (await countUrl(b, PB_URL)) === 1);

  // A second ruleset, Social, with B in it as well as in Default.
  await openRulesets(dash);
  await dash.getByRole("button", { name: "New ruleset" }).click();
  await dash.fill("#ruleset-name", "Social");
  await addRuleKind(dash, "blockDomain");
  await dash.getByLabel("example.com (also blocks its subdomains)").fill("127.0.0.1");
  await dash.getByRole("button", { name: "Add", exact: true }).click();
  check("dashboard: Social ruleset is created", await saveRules(dash, "Create ruleset"));
  await dash.locator("label", { hasText: "E2E device B" }).locator('input[type="checkbox"]').check();
  await dash.getByRole("button", { name: "Save devices" }).click();
  check("dashboard: B is assigned to Social", await dash.getByText("Devices saved.").waitFor({ timeout: 30_000 }).then(() => true, () => false));

  const popupLine = await waitFor(async () => {
    await syncNow(cb.popup).catch(() => {});
    await cb.popup.reload();
    await cb.popup.waitForSelector(".status-card", { timeout: 15_000 }).catch(() => {});
    const text = await cb.popup.locator("#rulesets-line").innerText().catch(() => "");
    return /Default/.test(text) && /Social/.test(text) ? text : false;
  }, { timeout: 90_000, interval: 3_000 });
  check("popup: B shows both its rulesets", !!popupLine, String(popupLine));

  // History on B: the pattern (Default) and the domain (Social) are kept out.
  for (const url of [PATTERN_URL, DOMAIN_URL, ALLOWED_URL]) await (await openPage(b, url, "page")).close();
  const allowedArrived = await syncUntil([cb.popup, ca.popup], () => inHistory(a, ALLOWED_URL), 120_000);
  check("history: an allowed visit on B reaches A", allowedArrived === true);
  await syncUntil([cb.popup, ca.popup], async () => false, 10_000);
  check("history: a visit matching Default's pattern stays off the account", !(await inHistory(a, PATTERN_URL)));
  check("history: a visit to Social's blocked domain stays off the account", !(await inHistory(a, DOMAIN_URL)));
  check("history: B's own browser history keeps the blocked visits", (await inHistory(b, PATTERN_URL)) && (await inHistory(b, DOMAIN_URL)));

  // Dashboard: per-device test.
  await openRulesets(dash);
  await dash.getByRole("tab", { name: "Devices" }).click();
  await dash.getByRole("button", { name: /E2E device B/ }).click();
  await dash.getByLabel("https://example.com/page").fill(DOMAIN_URL);
  await dash.getByRole("button", { name: "Test", exact: true }).click();
  const verdict = await dash.getByRole("status").innerText().catch(() => "");
  check("dashboard: the device test names the blocking rule and ruleset", /Blocked by/.test(verdict) && /Social/.test(verdict), verdict);
  await dash.getByRole("button", { name: /E2E device A/ }).click();
  await dash.getByLabel("https://example.com/page").fill(DOMAIN_URL);
  await dash.getByRole("button", { name: "Test", exact: true }).click();
  const verdictA = await dash.getByRole("status").innerText().catch(() => "");
  check("dashboard: the same address is allowed on A (not in Social)", /Not blocked/.test(verdictA), verdictA);

  // Lift the folder rule: both Personal folders merge, nothing is duplicated.
  await openRulesets(dash);
  await dash.locator("li", { hasText: "Don't sync folder:" }).getByRole("button", { name: "Remove" }).click();
  check("dashboard: Default saves without the folder rule", await saveRules(dash));
  const merged = await syncUntil(
    [ca.popup, cb.popup],
    async () => (await countUrl(b, P_URL)) === 1 && (await countUrl(a, PB_URL)) === 1,
    150_000,
  );
  check("bookmarks: lifting the rule brings A's excluded bookmark to B", (await countUrl(b, P_URL)) === 1);
  check("bookmarks: lifting the rule uploads B's own bookmark to A", (await countUrl(a, PB_URL)) === 1, merged ? "" : `A has ${await countUrl(a, PB_URL)}`);
  const foldersA = (await foldersTitled(a, PERSONAL)).length;
  const foldersB = (await foldersTitled(b, PERSONAL)).length;
  check("bookmarks: one Personal folder on each device after the merge", foldersA === 1 && foldersB === 1, `A ${foldersA}, B ${foldersB}`);
  check("bookmarks: no bookmark is duplicated", (await countUrl(a, P_URL)) === 1 && (await countUrl(b, PB_URL)) === 1 && (await countUrl(b, W_URL)) === 1);
} catch (e) {
  check("test ran to completion", false, e.message.split("\n")[0]);
} finally {
  for (const d of devices) await d.ctx.close().catch(() => {});
}

const extensionProblems = readFileSync(LOG, "utf8")
  .split("\n")
  .filter((line) => /^\[[AB] (worker|popup) (error|warn|warning|pageerror)\]/.test(line))
  .filter((line) => !/\] Failed to load resource: the server responded with a status of 401 /.test(line));
check(
  "extension: no errors or warnings in its console",
  extensionProblems.length === 0,
  extensionProblems.length ? `${extensionProblems.length}:\n    ${[...new Set(extensionProblems)].slice(0, 20).join("\n    ")}` : "",
);

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
if (failed) console.log(`Browser console output and profiles kept in ${WORK}`);
else rmSync(WORK, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
