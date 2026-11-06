import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import {
  DEFAULT_LANGUAGE,
  LANGUAGES,
  isSupportedLanguage,
  languageDir,
  matchBrowserLanguages,
  type LanguageCode,
} from "./languages";

/** The dashboard and the extension popup are different origins, so each keeps
 * its own choice. */
const STORAGE_KEY = "helixsync.language";

function storedLanguage(): LanguageCode | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return isSupportedLanguage(value) ? value : null;
  } catch {
    return null;
  }
}

function detectLanguage(): LanguageCode {
  const browser = typeof navigator === "undefined" ? [] : (navigator.languages ?? [navigator.language]);
  return storedLanguage() ?? matchBrowserLanguages(browser);
}

function applyDocumentLanguage(code: string): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = code;
  document.documentElement.dir = languageDir(code);
}

/** English ships in the main bundle (it is the fallback); every other
 * catalog is fetched when it is first used. */
const loaders: Record<Exclude<LanguageCode, "en">, () => Promise<{ default: object }>> = {
  hu: () => import("./locales/hu.json"),
  de: () => import("./locales/de.json"),
  es: () => import("./locales/es.json"),
  fr: () => import("./locales/fr.json"),
  "zh-CN": () => import("./locales/zh-CN.json"),
  ar: () => import("./locales/ar.json"),
};

let latestRequest = 0;

async function activate(code: LanguageCode): Promise<void> {
  const mine = ++latestRequest;
  await ready;
  if (code !== "en" && !i18n.hasResourceBundle(code, "translation")) {
    try {
      i18n.addResourceBundle(code, "translation", (await loaders[code]()).default);
    } catch {
      return; // Offline or blocked: stay on the current language.
    }
  }
  if (mine !== latestRequest) return; // A newer choice superseded this one.
  await i18n.changeLanguage(code);
}

const ready = i18n.use(initReactI18next).init({
  resources: { en: { translation: en } },
  lng: DEFAULT_LANGUAGE,
  fallbackLng: DEFAULT_LANGUAGE,
  supportedLngs: LANGUAGES.map((l) => l.code),
  interpolation: { escapeValue: false }, // React escapes.
  returnNull: false,
});

applyDocumentLanguage(i18n.language);
i18n.on("languageChanged", applyDocumentLanguage);
void activate(detectLanguage());

/** Switches the interface language and remembers the choice in this browser. */
export async function setLanguage(code: LanguageCode): Promise<void> {
  await activate(code);
  if (i18n.language !== code) return; // Not applied (load failed or superseded): don't remember it.
  try {
    localStorage.setItem(STORAGE_KEY, code);
  } catch {
    // Private mode or blocked storage: the choice just lasts for this visit.
  }
}

export default i18n;
