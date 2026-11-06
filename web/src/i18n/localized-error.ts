import en from "./locales/en.json";

function lookup(key: string): string | undefined {
  let node: unknown = en;
  for (const part of key.split(".")) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" ? node : undefined;
}

/** An error the UI shows to a person: a catalog key plus its parameters, so it
 * is translated where it is displayed (see errorText). `message` is the English
 * text, kept for logs and tests. Depends only on the English catalog, so the
 * crypto and passkey code stay free of the i18n runtime. */
export class LocalizedError extends Error {
  constructor(
    public readonly key: string,
    public readonly params: Record<string, unknown> = {},
    english?: string,
  ) {
    super(
      english ??
        (lookup(key) ?? key).replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, name: string) =>
          name in params ? String(params[name]) : whole,
        ),
    );
    this.name = "LocalizedError";
  }
}
