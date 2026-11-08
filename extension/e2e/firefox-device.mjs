// A Firefox device for sync.e2e.mjs, driven over WebDriver BiDi (built into
// Firefox; no geckodriver). Playwright can't load an extension into Firefox,
// so this gives the e2e test the small part of Playwright's Page API it uses,
// against a real Firefox with dist-firefox/ installed as a temporary add-on.
import { spawn } from "child_process";
import { appendFileSync, cpSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { createServer as createHttpServer } from "http";
import { createServer } from "net";
import { join } from "path";

const ADDON_ID = "helixsync-e2e@example.test";
const UUID = "4d1c7f2e-0b6a-4f5e-9a3c-e2e0e2e0e2e0";
export const FIREFOX_EXTENSION_ORIGIN = `moz-extension://${UUID}`;

const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });

// Loaded first in the background page and the popup of the test's copy. BiDi
// doesn't report an extension's console, so this posts every console call,
// uncaught error and unhandled rejection to the test's log server.
const consoleHook = (port) => `(() => {
  const where = location.pathname.includes("background") ? "background" : location.pathname.replace(/^\\/|\\.html$/g, "");
  const show = (a) => {
    if (a instanceof Error) return a.stack || String(a);
    if (typeof a === "string") return a;
    try { return JSON.stringify(a); } catch { return String(a); }
  };
  const send = (level, args) => {
    try {
      fetch("http://127.0.0.1:${port}/", { method: "POST", mode: "no-cors", body: JSON.stringify({ where, level, text: args.map(show).join(" ") }) }).catch(() => {});
    } catch {}
  };
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    const original = console[level].bind(console);
    console[level] = (...args) => { send(level, args); original(...args); };
  }
  addEventListener("error", (e) => send("pageerror", [e.error || e.message]));
  addEventListener("unhandledrejection", (e) => send("unhandledrejection", [e.reason]));
})();
`;

/** Copies dist-firefox/ to `dir` with a fixed add-on id, an empty page to run
 * extension API calls in, and the console hook, whose messages go to `log`
 * as `[label where level] text`. Permissions stay as shipped: the profile
 * grants optional-permission requests without a prompt (see launchFirefox),
 * so the extension's own requests for the server and tab groups are
 * exercised. Returns a function that stops the log server. */
export async function prepareFirefoxExtension(distFirefox, dir, log, label) {
  const server = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      try {
        const { where, level, text } = JSON.parse(body);
        appendFileSync(log, `[${label} ${where} ${level}] ${text}\n`);
      } catch {}
      res.writeHead(204, { "Access-Control-Allow-Origin": "*" }).end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  cpSync(distFirefox, dir, { recursive: true });
  writeFileSync(join(dir, "e2e-console.js"), consoleHook(port));
  const path = join(dir, "manifest.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  manifest.browser_specific_settings = { gecko: { ...manifest.browser_specific_settings?.gecko, id: ADDON_ID } };
  manifest.background.scripts = ["e2e-console.js", ...manifest.background.scripts];
  writeFileSync(path, JSON.stringify(manifest, null, 2));
  const popupPath = join(dir, "popup.html");
  writeFileSync(popupPath, readFileSync(popupPath, "utf8").replace("<head>", '<head><script src="/e2e-console.js"></script>'));
  writeFileSync(join(dir, "e2e-api.html"), "<!doctype html><meta charset=utf-8><title>e2e</title>");
  return () => server.close();
}

class Bidi {
  constructor(ws) {
    this.ws = ws;
    this.next = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.type === "error") reject(new Error(`${msg.error}: ${msg.message}`));
        else resolve(msg.result);
      } else if (msg.type === "event") {
        for (const l of this.listeners) l(msg);
      }
    });
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.next;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

// Runs in the page: finds the elements a locator's steps describe.
const RESOLVE = `(steps) => {
  let els = [document];
  const textOf = (e) => (e.getAttribute("aria-label") || e.textContent || e.value || "").replace(/\\s+/g, " ").trim();
  for (const s of steps) {
    if (s.css) {
      els = els.flatMap((e) => [...e.querySelectorAll(s.css)]);
      if (s.has) els = els.filter((e) => e.querySelector(s.has));
      if (s.hasText) els = els.filter((e) => e.textContent.includes(s.hasText));
    } else if (s.role) {
      els = els.flatMap((e) => [...e.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]')]);
      els = els.filter((e) => (s.exact ? textOf(e) === s.name : textOf(e).toLowerCase().includes(s.name.toLowerCase())));
    } else if (s.nth !== undefined) {
      els = els.slice(s.nth, s.nth + 1);
    }
  }
  return els.filter((e) => e !== document);
}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Locator {
  constructor(page, steps) {
    this.page = page;
    this.steps = steps;
  }
  locator(css, opts = {}) {
    return new Locator(this.page, [...this.steps, { css, has: opts.has?.cssOnly(), hasText: opts.hasText }]);
  }
  getByRole(role, { name, exact } = {}) {
    return new Locator(this.page, [...this.steps, { role, name, exact }]);
  }
  first() {
    return new Locator(this.page, [...this.steps, { nth: 0 }]);
  }
  nth(n) {
    return new Locator(this.page, [...this.steps, { nth: n }]);
  }
  cssOnly() {
    if (this.steps.length !== 1 || !this.steps[0].css || this.steps[0].has) throw new Error("has: takes a plain CSS locator");
    return this.steps[0].css;
  }
  #run(body, arg) {
    return this.page.evaluate(
      new Function("a", `const els = (${RESOLVE})(a.steps); return (${body})(els, a.arg);`),
      { steps: this.steps, arg },
    );
  }
  count() {
    return this.#run("(els) => els.length");
  }
  async waitFor({ timeout = 30_000 } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if ((await this.count().catch(() => 0)) > 0) return;
      await sleep(250);
    }
    throw new Error(`timed out waiting for ${JSON.stringify(this.steps)}`);
  }
  async textContent() {
    await this.waitFor();
    return this.#run("(els) => els[0].textContent");
  }
  async innerText() {
    await this.waitFor();
    return this.#run("(els) => els[0].innerText");
  }
  evaluateAll(fn) {
    return this.#run(`(els) => (${fn})(els)`);
  }
  async click() {
    await this.waitFor();
    await this.page.clickElement(this.steps);
  }
}

class FirefoxPage {
  constructor(dev, context, kind) {
    this.dev = dev;
    this.bidi = dev.bidi;
    this.context = context;
    this.kind = kind;
    this.lastUrl = "about:blank";
  }
  url() {
    return this.lastUrl;
  }
  async goto(url) {
    const r = await this.bidi.send("browsingContext.navigate", { context: this.context, url, wait: "complete" });
    this.lastUrl = r.url;
  }
  async reload() {
    await this.bidi.send("browsingContext.reload", { context: this.context, wait: "complete" });
  }
  async close() {
    await this.bidi.send("browsingContext.close", { context: this.context }).catch(() => {});
  }
  /** Like Playwright's page.evaluate: `fn` is serialized, `arg` is JSON. */
  async evaluate(fn, arg) {
    const r = await this.bidi.send("script.evaluate", {
      target: { context: this.context },
      awaitPromise: true,
      expression: `(async () => { const v = await (${fn})(${arg === undefined ? "" : JSON.stringify(arg)}); return v === undefined ? "__undefined__" : JSON.stringify(v); })()`,
    });
    if (r.type === "exception") throw new Error(`evaluate: ${r.exceptionDetails.text}`);
    const value = r.result.value;
    return value === "__undefined__" ? undefined : JSON.parse(value);
  }
  locator(css, opts) {
    return new Locator(this, []).locator(css, opts);
  }
  getByRole(role, opts) {
    return new Locator(this, []).getByRole(role, opts);
  }
  /** A real (trusted) click, so permissions.request() sees user input. */
  async clickElement(steps) {
    const ref = await this.bidi.send("script.evaluate", {
      target: { context: this.context },
      awaitPromise: false,
      resultOwnership: "root",
      expression: `(() => { const e = (${RESOLVE})(${JSON.stringify(steps)})[0]; e.scrollIntoView({ block: "center" }); return e; })()`,
    });
    if (ref.type === "exception") throw new Error(`click: ${ref.exceptionDetails.text}`);
    const element = { sharedId: ref.result.sharedId };
    await this.bidi.send("input.performActions", {
      context: this.context,
      actions: [
        {
          type: "pointer",
          id: "mouse",
          actions: [
            { type: "pointerMove", x: 0, y: 0, origin: { type: "element", element } },
            { type: "pointerDown", button: 0 },
            { type: "pointerUp", button: 0 },
          ],
        },
      ],
    });
  }
  click(css) {
    return this.locator(css).click();
  }
  async waitForSelector(css, { timeout = 30_000 } = {}) {
    await this.locator(css).waitFor({ timeout });
  }
  async fill(css, value) {
    await this.waitForSelector(css);
    await this.evaluate(
      ({ css, value }) => {
        const el = document.querySelector(css);
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      },
      { css, value },
    );
  }
  async selectOption(css, value) {
    await this.waitForSelector(css);
    await this.evaluate(
      ({ css, value }) => {
        const el = document.querySelector(css);
        el.value = value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      },
      { css, value },
    );
  }
  isChecked(css) {
    return this.evaluate((css) => document.querySelector(css).checked, css);
  }
  textContent(css) {
    return this.locator(css).textContent();
  }
  async waitForURL(url, { timeout = 30_000 } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      this.lastUrl = await this.evaluate(() => location.href).catch(() => this.lastUrl);
      if (this.lastUrl === url) return;
      await sleep(250);
    }
    throw new Error(`timed out waiting for ${url}, at ${this.lastUrl}`);
  }
  waitForTimeout(ms) {
    return sleep(ms);
  }
  on() {}
}

/** Starts Firefox with the prepared extension installed. The returned device
 * has the shape sync.e2e.mjs's Chromium devices have: `sw.evaluate` runs in
 * an extension page (Firefox's background page has the same APIs), and
 * `newPage(url, kind)` opens a tab. */
export async function launchFirefox({ label, exe, work, extDir, log, prefs = {} }) {
  const profile = mkdtempSync(join(work, `profile-${label}-`));
  writeFileSync(
    join(profile, "user.js"),
    [
      `user_pref("extensions.webextensions.uuids", ${JSON.stringify(JSON.stringify({ [ADDON_ID]: UUID }))});`,
      `user_pref("intl.locale.requested", "en-US");`,
      `user_pref("browser.shell.checkDefaultBrowser", false);`,
      `user_pref("datareporting.policy.dataSubmissionEnabled", false);`,
      `user_pref("browser.aboutwelcome.enabled", false);`,
      // Grants optional-permission requests without the prompt an automated
      // browser can't click; the request itself still has to be valid.
      `user_pref("extensions.webextOptionalPermissionPrompts", false);`,
      ...Object.entries(prefs).map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`),
    ].join("\n"),
  );
  const port = await freePort();
  const proc = spawn(exe, ["--headless", "--no-remote", `--remote-debugging-port=${port}`, "--profile", profile], {
    // Lets BiDi script moz-extension:// pages.
    env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: "1" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Firefox did not start WebDriver BiDi")), 30_000);
    proc.stderr.on("data", (d) => {
      if (/WebDriver BiDi listening/.test(String(d))) {
        clearTimeout(timer);
        resolve();
      }
    });
    proc.on("exit", (code) => reject(new Error(`Firefox exited (${code})`)));
  });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/session`);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
  });
  const bidi = new Bidi(ws);
  await bidi.send("session.new", { capabilities: { alwaysMatch: { unhandledPromptBehavior: { default: "ignore" } } } });
  await bidi.send("session.subscribe", { events: ["log.entryAdded"] });
  const kinds = new Map();
  bidi.listeners.push((msg) => {
    if (msg.method !== "log.entryAdded") return;
    const p = msg.params;
    const where = p.source?.context ? (kinds.get(p.source.context) ?? "page") : "bidi";
    appendFileSync(log, `[${label} ${where} ${p.level}] ${p.text}\n`);
  });
  await bidi.send("webExtension.install", { extensionData: { type: "path", path: extDir } });

  const dev = { label, kind: "firefox", bidi, proc, extensionOrigin: FIREFOX_EXTENSION_ORIGIN };
  dev.newPage = async (url, kind = "page") => {
    const { context } = await bidi.send("browsingContext.create", { type: "tab", background: true });
    kinds.set(context, kind);
    const page = new FirefoxPage(dev, context, kind);
    if (url) await page.goto(url);
    return page;
  };
  let api;
  /** (Re)opens the extension page API calls run in; after the extension
   * reloads, its old pages are gone and the new ones load once it is back. */
  dev.reopenApi = async () => {
    const deadline = Date.now() + 30_000;
    for (;;) {
      await sleep(1_000);
      try {
        const page = await dev.newPage(`${FIREFOX_EXTENSION_ORIGIN}/e2e-api.html`, "api");
        // Firefox's chrome.* is callback-only; the test's calls expect promises.
        await page.evaluate(() => {
          globalThis.chrome = browser;
        });
        api = page;
        return;
      } catch (e) {
        if (Date.now() > deadline) throw e;
      }
    }
  };
  await dev.reopenApi();
  dev.sw = { evaluate: (fn, arg) => api.evaluate(fn, arg) };
  dev.ctx = {
    close: async () => {
      ws.close();
      proc.kill();
    },
  };
  return dev;
}
