// Interface language for the popup. Not chrome.i18n.getMessage: that is fixed
// to the browser's UI language and cannot be switched at runtime. The catalogs
// are the standard _locales/<lang>/messages.json files (so the manifest's
// __MSG_*__ strings use the same ones), read with fetch.

export const LANGUAGES = [
  { code: "en", name: "English", dir: "ltr", folder: "en" },
  { code: "hu", name: "Magyar", dir: "ltr", folder: "hu" },
  { code: "de", name: "Deutsch", dir: "ltr", folder: "de" },
  { code: "es", name: "Español", dir: "ltr", folder: "es" },
  { code: "zh-CN", name: "简体中文", dir: "ltr", folder: "zh_CN" },
  { code: "ar", name: "العربية", dir: "rtl", folder: "ar" },
  { code: "fr", name: "Français", dir: "ltr", folder: "fr" },
] as const;

export type LanguageCode = (typeof LANGUAGES)[number]["code"];
export const DEFAULT_LANGUAGE: LanguageCode = "en";

/** chrome.storage.local key of the user's explicit choice. */
export const LANGUAGE_STORAGE_KEY = "uiLanguage";

export function isSupportedLanguage(value: unknown): value is LanguageCode {
  return LANGUAGES.some((l) => l.code === value);
}

/** Maps one browser language tag ("de-AT", "zh-Hans-CN") to a supported
 * language, or null. Traditional Chinese is not covered. */
export function matchLanguageTag(tag: string): LanguageCode | null {
  const parts = tag.trim().replace(/_/g, "-").toLowerCase().split("-");
  if (parts[0] === "zh") {
    const rest = parts.slice(1);
    if (rest.includes("hant") || rest.includes("tw") || rest.includes("hk") || rest.includes("mo")) return null;
    return "zh-CN";
  }
  const found = LANGUAGES.find((l) => l.code.toLowerCase() === parts[0]);
  return found ? found.code : null;
}

export function matchBrowserLanguages(tags: readonly string[]): LanguageCode {
  for (const tag of tags) {
    const match = matchLanguageTag(tag);
    if (match) return match;
  }
  return DEFAULT_LANGUAGE;
}

/** The shape of messages.json. Only `message` is used; keys are flat
 * (Chrome allows letters, digits, "_" and "@"). Plural forms are
 * `<key>_zero|one|two|few|many|other`. */
export type Catalog = Record<string, { message: string }>;

export type Params = Record<string, string | number>;

export interface Translator {
  language: LanguageCode;
  t: (key: string, params?: Params) => string;
  has: (key: string) => boolean;
  /** The `<key>_<category>` form for `count` in this language (`other` when
   * that category is missing), with `count` available as {count}. */
  tp: (key: string, count: number, params?: Params) => string;
}

function interpolate(message: string, params?: Params): string {
  if (!params) return message;
  return message.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole,
  );
}

/** Pure: a translator over `messages`, falling back to `fallback` (English)
 * and finally to the key itself. */
export function createTranslator(language: LanguageCode, messages: Catalog, fallback: Catalog = {}): Translator {
  const lookup = (key: string): string | undefined => messages[key]?.message ?? fallback[key]?.message;
  const rules = new Intl.PluralRules(language);
  return {
    language,
    t: (key, params) => interpolate(lookup(key) ?? key, params),
    has: (key) => lookup(key) !== undefined,
    tp: (key, count, params) => {
      const text = lookup(`${key}_${rules.select(count)}`) ?? lookup(`${key}_other`) ?? key;
      return interpolate(text, { count: formatCount(language, count), ...params });
    },
  };
}

function formatCount(language: string, count: number): string {
  return new Intl.NumberFormat(language).format(count);
}

// --- Runtime state ------------------------------------------------------------

let translator: Translator = createTranslator(DEFAULT_LANGUAGE, {});

export const t: Translator["t"] = (key, params) => translator.t(key, params);
export const tp: Translator["tp"] = (key, count, params) => translator.tp(key, count, params);
export const hasMessage: Translator["has"] = (key) => translator.has(key);

export function currentLanguage(): LanguageCode {
  return translator.language;
}

export function currentDir(): "ltr" | "rtl" {
  return LANGUAGES.find((l) => l.code === translator.language)?.dir ?? "ltr";
}

async function loadCatalog(code: LanguageCode): Promise<Catalog> {
  const folder = LANGUAGES.find((l) => l.code === code)!.folder;
  const response = await fetch(chrome.runtime.getURL(`_locales/${folder}/messages.json`));
  if (!response.ok) throw new Error(`Could not load the ${code} messages`);
  return (await response.json()) as Catalog;
}

async function storedLanguage(): Promise<LanguageCode | null> {
  try {
    const value = (await chrome.storage.local.get(LANGUAGE_STORAGE_KEY))[LANGUAGE_STORAGE_KEY];
    return isSupportedLanguage(value) ? value : null;
  } catch {
    return null;
  }
}

function browserLanguages(): string[] {
  const ui = chrome.i18n?.getUILanguage?.();
  return [...(ui ? [ui] : []), ...(typeof navigator === "undefined" ? [] : navigator.languages ?? [])];
}

/** The explicit choice if there is one, else the browser's. */
export async function resolveLanguage(): Promise<LanguageCode> {
  return (await storedLanguage()) ?? matchBrowserLanguages(browserLanguages());
}

export function applyDocumentLanguage(): void {
  document.documentElement.lang = translator.language;
  document.documentElement.dir = currentDir();
}

/** A translator for the resolved language, without touching module state or
 * the DOM, so the service worker can use it too. A missing or broken catalog
 * leaves English in place. */
export async function loadTranslator(): Promise<Translator> {
  const language = await resolveLanguage();
  const english = loadCatalog("en").catch((): Catalog => ({}));
  const [en, messages] = await Promise.all([
    english,
    language === "en" ? english : loadCatalog(language).catch((): Catalog => ({})),
  ]);
  return createTranslator(language, messages, en);
}

/** Loads the catalogs for the resolved language. A missing or broken catalog
 * leaves English in place rather than a blank popup. */
export async function initI18n(): Promise<void> {
  translator = await loadTranslator();
  applyDocumentLanguage();
}

/** Remembers `code` (or, with null, goes back to following the browser) and
 * reloads the catalogs. */
export async function setUiLanguage(code: LanguageCode | null): Promise<void> {
  if (code === null) await chrome.storage.local.remove(LANGUAGE_STORAGE_KEY);
  else await chrome.storage.local.set({ [LANGUAGE_STORAGE_KEY]: code });
  await initI18n();
}

// --- Formatting -----------------------------------------------------------------

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(translator.language);
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(translator.language, options).format(value);
}

/** "5 minutes ago" in the active language. */
export function timeAgo(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return t("time_never");
  const seconds = Math.floor((now - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(seconds)) return t("time_never");
  if (seconds < 5) return t("time_justNow");
  const rtf = new Intl.RelativeTimeFormat(translator.language, { numeric: "auto" });
  if (seconds < 60) return rtf.format(-seconds, "second");
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return rtf.format(-minutes, "minute");
  return rtf.format(-Math.floor(minutes / 60), "hour");
}
