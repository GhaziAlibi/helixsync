import { describe, expect, it } from "vitest";
import ar from "./locales/ar.json";
import de from "./locales/de.json";
import en from "./locales/en.json";
import es from "./locales/es.json";
import fr from "./locales/fr.json";
import hu from "./locales/hu.json";
import zhCN from "./locales/zh-CN.json";

const others = { hu, de, es, fr, "zh-CN": zhCN, ar } as Record<string, unknown>;

function flatten(value: unknown, prefix = "", out: Record<string, string> = {}): Record<string, string> {
  if (typeof value === "string") out[prefix] = value;
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  }
  return out;
}

/** {{name}} placeholders and <tag> markers a translation must keep. */
function tokens(text: string): string[] {
  const found = text.match(/\{\{\s*\w+\s*\}\}|<\/?\w+>/g) ?? [];
  return found.map((t) => t.replace(/\s+/g, "")).sort();
}

const base = flatten(en);

describe("locale catalogs", () => {
  for (const [code, catalog] of Object.entries(others)) {
    describe(code, () => {
      const flat = flatten(catalog);

      it("has exactly the keys of English", () => {
        expect(Object.keys(flat).sort()).toEqual(Object.keys(base).sort());
      });

      it("keeps every placeholder and markup tag", () => {
        for (const [key, text] of Object.entries(base)) {
          expect(tokens(flat[key] ?? ""), `${code}:${key}`).toEqual(tokens(text));
        }
      });

      it("has no empty strings", () => {
        for (const [key, text] of Object.entries(flat)) expect(text.trim(), `${code}:${key}`).not.toBe("");
      });
    });
  }
});
