const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** True when the page was loaded over plain HTTP from anything but this
 * machine. The server marks its session cookies `Secure`, which browsers only
 * honour over HTTPS (loopback excepted), so signing in on such a page appears
 * to work and then silently doesn't stick, and the credentials would also
 * cross the network unencrypted. */
export function isInsecureRemoteHttp(protocol: string, hostname: string): boolean {
  return protocol === "http:" && !LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());
}
