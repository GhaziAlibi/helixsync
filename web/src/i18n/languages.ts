/** The interface languages, each named in itself. `en` is the default and the
 * fallback for any missing key. */
export const LANGUAGES = [
  { code: "en", name: "English", dir: "ltr" },
  { code: "hu", name: "Magyar", dir: "ltr" },
  { code: "de", name: "Deutsch", dir: "ltr" },
  { code: "es", name: "Español", dir: "ltr" },
  { code: "zh-CN", name: "简体中文", dir: "ltr" },
  { code: "ar", name: "العربية", dir: "rtl" },
  { code: "fr", name: "Français", dir: "ltr" },
] as const;

export type LanguageCode = (typeof LANGUAGES)[number]["code"];

export const DEFAULT_LANGUAGE: LanguageCode = "en";

export function isSupportedLanguage(value: unknown): value is LanguageCode {
  return LANGUAGES.some((l) => l.code === value);
}

export function languageDir(code: string): "ltr" | "rtl" {
  return LANGUAGES.find((l) => l.code === code)?.dir ?? "ltr";
}

/** Maps one browser language tag ("de-AT", "zh-Hans-CN") to a supported
 * language, or null. Traditional Chinese (zh-TW, zh-HK, zh-Hant) is not
 * covered, so it is not matched. */
export function matchLanguageTag(tag: string): LanguageCode | null {
  const parts = tag.trim().replace(/_/g, "-").toLowerCase().split("-");
  const base = parts[0];
  if (base === "zh") {
    const rest = parts.slice(1);
    if (rest.includes("hant") || rest.includes("tw") || rest.includes("hk") || rest.includes("mo")) return null;
    return "zh-CN";
  }
  const found = LANGUAGES.find((l) => l.code.toLowerCase() === base);
  return found ? found.code : null;
}

/** The first supported language in the browser's preference order. */
export function matchBrowserLanguages(tags: readonly string[]): LanguageCode {
  for (const tag of tags) {
    const match = matchLanguageTag(tag);
    if (match) return match;
  }
  return DEFAULT_LANGUAGE;
}
