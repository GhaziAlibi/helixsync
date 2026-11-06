import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import ar from "./locales/ar.json";
import de from "./locales/de.json";
import en from "./locales/en.json";
import es from "./locales/es.json";
import fr from "./locales/fr.json";
import hu from "./locales/hu.json";
import zhCN from "./locales/zh-CN.json";
import {
  DEFAULT_LANGUAGE,
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

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    hu: { translation: hu },
    de: { translation: de },
    es: { translation: es },
    fr: { translation: fr },
    "zh-CN": { translation: zhCN },
    ar: { translation: ar },
  },
  lng: detectLanguage(),
  fallbackLng: DEFAULT_LANGUAGE,
  supportedLngs: ["en", "hu", "de", "es", "fr", "zh-CN", "ar"],
  interpolation: { escapeValue: false }, // React escapes.
  returnNull: false,
});

applyDocumentLanguage(i18n.language);
i18n.on("languageChanged", applyDocumentLanguage);

/** Switches the interface language and remembers the choice in this browser. */
export async function setLanguage(code: LanguageCode): Promise<void> {
  try {
    localStorage.setItem(STORAGE_KEY, code);
  } catch {
    // Private mode or blocked storage: the choice just lasts for this visit.
  }
  await i18n.changeLanguage(code);
}

export default i18n;
