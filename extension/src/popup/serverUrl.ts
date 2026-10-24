// SEC-17: over plain http a network attacker could read the authKey and
// device tokens. Loopback is allowed for local development.
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

export class InsecureServerUrlError extends Error {}

export function assertSecureServerUrl(serverUrl: string): void {
  const url = new URL(serverUrl);
  if (url.protocol === "https:") return;
  if (url.protocol === "http:" && LOOPBACK_HOSTNAMES.has(url.hostname)) return;
  throw new InsecureServerUrlError(
    "The Server URL must use https:// (http:// is only allowed for localhost, 127.0.0.1 or [::1]).",
  );
}
