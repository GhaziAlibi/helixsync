import { describe, expect, it } from "vitest";
import { languageDir, matchBrowserLanguages, matchLanguageTag } from "./languages";

describe("matchLanguageTag", () => {
  it("maps regional tags to the base language", () => {
    expect(matchLanguageTag("de-AT")).toBe("de");
    expect(matchLanguageTag("es-MX")).toBe("es");
    expect(matchLanguageTag("hu")).toBe("hu");
    expect(matchLanguageTag("ar-EG")).toBe("ar");
    expect(matchLanguageTag("en-GB")).toBe("en");
  });

  it("maps simplified Chinese tags and skips traditional ones", () => {
    expect(matchLanguageTag("zh")).toBe("zh-CN");
    expect(matchLanguageTag("zh-CN")).toBe("zh-CN");
    expect(matchLanguageTag("zh-Hans-CN")).toBe("zh-CN");
    expect(matchLanguageTag("zh-TW")).toBeNull();
    expect(matchLanguageTag("zh-Hant")).toBeNull();
  });

  it("returns null for unsupported languages", () => {
    expect(matchLanguageTag("ja-JP")).toBeNull();
    expect(matchLanguageTag("fr-CA")).toBe("fr");
  });
});

describe("matchBrowserLanguages", () => {
  it("takes the first supported language in preference order", () => {
    expect(matchBrowserLanguages(["ja-JP", "de-DE", "en"])).toBe("de");
  });
  it("falls back to English", () => {
    expect(matchBrowserLanguages(["ja", "ko"])).toBe("en");
    expect(matchBrowserLanguages([])).toBe("en");
  });
});

describe("languageDir", () => {
  it("is rtl only for Arabic", () => {
    expect(languageDir("ar")).toBe("rtl");
    expect(languageDir("de")).toBe("ltr");
    expect(languageDir("zh-CN")).toBe("ltr");
  });
});
