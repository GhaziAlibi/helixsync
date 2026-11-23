// What a rule blocks. Pure, no browser APIs beyond `URL` and `RegExp`.
//
// The extension enforces rulesets; this copy only powers the dashboard's
// "test a URL" box. The two must agree, so both are tested against the same
// `fixtures/matcher-vectors.json` (kept identical in extension/src/rulesets/).
import type { Rule } from "./types";

/** Regexes are only run on this much of a URL, so one rule can't be made to
 * grind on a huge address. */
export const MAX_MATCHED_URL_LENGTH = 2048;

const HOST_SCHEMES = new Set(["http:", "https:", "ftp:", "ws:", "wss:"]);

/** The host of a web address: lower case, no brackets around an IPv6 address,
 * no trailing dot. `null` for an address that doesn't parse or isn't a web
 * address (`chrome://settings` has no host a domain rule could mean). */
export function hostOf(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!HOST_SCHEMES.has(parsed.protocol)) return null;
  const host = stripHost(parsed.hostname);
  return host === "" ? null : host;
}

function stripHost(hostname: string): string {
  let host = hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  while (host.endsWith(".")) host = host.slice(0, -1);
  return host;
}

const LABEL = "[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?";
const LABELS = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`);

/** The host a domain rule stands for, or `null` if `input` isn't one.
 * Forgiving about what people paste: `https://www.Example.com/path`,
 * `*.example.com` and `example.com:8080` all become the bare host. An IDN
 * becomes its punycode form, like the host of a real address does. */
export function normalizeDomain(input: string): string | null {
  let text = input.trim().toLowerCase();
  if (text === "") return null;
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  text = text.split(/[/?#]/, 1)[0];
  const at = text.lastIndexOf("@");
  if (at !== -1) text = text.slice(at + 1);
  text = text.replace(/^\*\./, "").replace(/^\.+/, "");
  // A bare IPv6 address (`::1`) is bracketed the way a URL writes it.
  if (/^[0-9a-f]*:[0-9a-f:.]*:[0-9a-f:.]*$/.test(text)) text = `[${text}]`;
  if (!text.startsWith("[")) text = text.replace(/:\d+$/, "");
  if (text === "" || /\s/.test(text)) return null;

  let host: string;
  try {
    host = stripHost(new URL(`http://${text}`).hostname);
  } catch {
    return null;
  }
  if (host === "" || host.length > 253) return null;
  if (host.includes(":")) return host; // an IPv6 address, validated by URL
  return LABELS.test(host) ? host : null;
}

/** True when `host` is `domain` or a subdomain of it. */
export function hostMatchesDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function ipv4Octets(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const octets = m.slice(1).map(Number);
  return octets.every((o) => o <= 255) ? octets : null;
}

const LOCAL_SUFFIXES = [".localhost", ".local", ".test", ".internal"];

/** localhost, `*.localhost`, `*.local`, `*.test`, `*.internal`, 127.0.0.0/8,
 * `::1` and the private IPv4 ranges (10/8, 172.16/12, 192.168/16). */
export function isLocalHost(host: string): boolean {
  if (host === "localhost" || LOCAL_SUFFIXES.some((s) => host.endsWith(s))) return true;
  if (host === "::1") return true;
  const o = ipv4Octets(host);
  if (!o) return false;
  return o[0] === 127 || o[0] === 10 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168);
}

/** The compiled regex of a pattern rule, or `null` when it doesn't compile
 * (such a rule matches nothing). Case-insensitive. */
export function compilePattern(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, "i");
  } catch {
    return null;
  }
}

/** True when `rule` blocks `url`. Folder rules never block a URL. */
export function ruleBlocksUrl(rule: Rule, url: string): boolean {
  switch (rule.kind) {
    case "blockDomain": {
      const host = hostOf(url);
      const domain = normalizeDomain(rule.domain);
      return host !== null && domain !== null && hostMatchesDomain(host, domain);
    }
    case "blockLocal": {
      const host = hostOf(url);
      return host !== null && isLocalHost(host);
    }
    case "blockPattern": {
      const re = compilePattern(rule.pattern);
      return re !== null && re.test(url.slice(0, MAX_MATCHED_URL_LENGTH));
    }
    default:
      return false;
  }
}
