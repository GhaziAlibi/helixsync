import { describe, expect, it } from "vitest";
import {
  LANGUAGES,
  createTranslator,
  matchBrowserLanguages,
  matchLanguageTag,
  type Catalog,
} from "./i18n";

const files = import.meta.glob<{ default: Catalog }>("../_locales/*/messages.json", { eager: true });
const catalogs = new Map(
  Object.entries(files).map(([path, module]) => [path.split("/")[2], module.default] as const),
);

function load(folder: string): Catalog {
  const catalog = catalogs.get(folder);
  if (!catalog) throw new Error(`no _locales/${folder}/messages.json`);
  return catalog;
}

const english = load("en");
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

/** {name} placeholders a translation must keep. */
function placeholders(text: string): string[] {
  return (text.match(/\{\w+\}/g) ?? []).sort();
}

/** The plural groups of the English catalog: key stem -> forms. */
function pluralStems(catalog: Catalog): Set<string> {
  return new Set(Object.keys(catalog).filter((k) => PLURAL_SUFFIX.test(k)).map((k) => k.replace(PLURAL_SUFFIX, "")));
}

/** The categories a language really uses for whole numbers. */
function usedCategories(code: string): Set<string> {
  const rules = new Intl.PluralRules(code);
  const used = new Set<string>();
  for (let n = 0; n <= 1000; n++) used.add(rules.select(n));
  return used;
}

describe("_locales", () => {
  it("has a folder for every language", () => {
    expect([...catalogs.keys()].sort()).toEqual(LANGUAGES.map((l) => l.folder).sort());
  });

  for (const { code, folder } of LANGUAGES) {
    describe(code, () => {
      const catalog = load(folder);
      const stems = pluralStems(english);

      it("translates every key of English (plural forms aside)", () => {
        const plain = (c: Catalog) => Object.keys(c).filter((k) => !PLURAL_SUFFIX.test(k)).sort();
        expect(plain(catalog)).toEqual(plain(english));
      });

      it("has every plural form the language uses, for every plural message", () => {
        const needed = usedCategories(code);
        for (const stem of stems) {
          for (const category of needed) {
            expect(catalog[`${stem}_${category}`], `${code}: ${stem}_${category}`).toBeDefined();
          }
          expect(catalog[`${stem}_other`], `${code}: ${stem}_other`).toBeDefined();
        }
      });

      it("has no plural form the language never uses", () => {
        const needed = usedCategories(code);
        for (const key of Object.keys(catalog)) {
          const match = key.match(PLURAL_SUFFIX);
          if (!match) continue;
          if (match[1] === "other") continue;
          // `many` of es is only for millions; it would be unreachable here.
          expect(needed.has(match[1]), `${code}: ${key}`).toBe(true);
        }
      });

      it("keeps every placeholder of English and adds none", () => {
        for (const [key, entry] of Object.entries(catalog)) {
          const stem = key.replace(PLURAL_SUFFIX, "");
          const source = english[key] ?? english[`${stem}_other`];
          expect(source, `${code}: ${key} has no English counterpart`).toBeDefined();
          const wanted = placeholders(source.message);
          const got = placeholders(entry.message);
          // A plural form may drop {count} (Arabic "two", "one"), nothing else.
          const allowedMissing = PLURAL_SUFFIX.test(key) ? ["{count}"] : [];
          expect(got.filter((p) => !wanted.includes(p)), `${code}: ${key} adds a placeholder`).toEqual([]);
          expect(
            wanted.filter((p) => !got.includes(p) && !allowedMissing.includes(p)),
            `${code}: ${key} drops a placeholder`,
          ).toEqual([]);
        }
      });

      it("has no empty messages and no literal dollar signs (Chrome reads them as placeholders)", () => {
        for (const [key, entry] of Object.entries(catalog)) {
          expect(entry.message.trim(), `${code}: ${key}`).not.toBe("");
          expect(entry.message, `${code}: ${key}`).not.toContain("$");
        }
      });
    });
  }
});

describe("createTranslator", () => {
  it("interpolates, falls back to English and then to the key", () => {
    const fr = createTranslator("de", { a: { message: "Hallo {name}" } }, { a: { message: "Hello {name}" }, b: { message: "Only English" } });
    expect(fr.t("a", { name: "Ada" })).toBe("Hallo Ada");
    expect(fr.t("b")).toBe("Only English");
    expect(fr.t("missing")).toBe("missing");
    expect(fr.has("b")).toBe(true);
    expect(fr.has("missing")).toBe(false);
  });

  it("leaves unknown placeholders alone", () => {
    expect(createTranslator("en", { a: { message: "{x} {y}" } }).t("a", { x: 1 })).toBe("1 {y}");
  });

  it("picks the plural form of the language", () => {
    const en = createTranslator("en", english);
    expect(en.tp("rp_bookmarks", 1)).toBe("1 bookmark");
    expect(en.tp("rp_bookmarks", 5)).toBe("5 bookmarks");
    const de = createTranslator("de", load("de"), english);
    expect(de.tp("rp_bookmarks", 3)).toBe("3 Lesezeichen");
  });

  it("covers the six Arabic plural categories", () => {
    const ar = createTranslator("ar", load("ar"), english);
    const forms = [0, 1, 2, 3, 11, 100].map((n) => ar.tp("auth_requests", n));
    expect(forms).toEqual([
      "طلبات تسجيل الدخول",
      "طلب تسجيل دخول",
      "طلبا تسجيل دخول",
      "طلبات تسجيل الدخول",
      "طلبات تسجيل الدخول",
      "طلبات تسجيل الدخول",
    ]);
    expect(ar.tp("rp_bookmarks", 2)).toBe("إشارتان مرجعيتان");
    expect(new Set([0, 1, 2, 3, 11, 100].map((n) => ar.tp("rp_previewDeleted", n))).size).toBe(6);
  });

  it("uses the single Chinese form", () => {
    const zh = createTranslator("zh-CN", load("zh_CN"), english);
    expect(zh.tp("rp_bookmarks", 1)).toContain("1");
    expect(zh.tp("rp_bookmarks", 7)).toContain("7");
  });
});

describe("language matching", () => {
  it("maps browser tags to supported languages", () => {
    expect(matchLanguageTag("de-CH")).toBe("de");
    expect(matchLanguageTag("zh-Hans")).toBe("zh-CN");
    expect(matchLanguageTag("zh-TW")).toBeNull();
    expect(matchLanguageTag("fr-CA")).toBe("fr");
    expect(matchLanguageTag("ja")).toBeNull();
    expect(matchBrowserLanguages(["ja", "hu-HU"])).toBe("hu");
    expect(matchBrowserLanguages(["ja"])).toBe("en");
  });
});
