/**
 * Generates a UUIDv7 (draft RFC 9562): a 48-bit millisecond timestamp
 * followed by cryptographically random bits, version/variant nibbles set
 * per spec. Used for objectId per docs/protocol.md §1.1 — time-ordered for
 * debugging/storage locality only; no code may rely on UUID ordering for
 * conflict resolution.
 */
// Precomputed hex table: uuidv7/deterministicUuid run thousands of times
// per backfill/snapshot, and `Array.from(bytes, b => b.toString(16)...`
// allocates a closure + 16 intermediate strings per call. A 256-entry
// lookup avoids all of that — same output, far less GC churn on the
// single MV3 thread.
const HEX_TABLE = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

function bytesToUuidHex(bytes: Uint8Array): string {
  // Unrolled 16-byte UUID layout: 8-4-4-4-12 hex chars.
  return (
    HEX_TABLE[bytes[0]] +
    HEX_TABLE[bytes[1]] +
    HEX_TABLE[bytes[2]] +
    HEX_TABLE[bytes[3]] +
    "-" +
    HEX_TABLE[bytes[4]] +
    HEX_TABLE[bytes[5]] +
    "-" +
    HEX_TABLE[bytes[6]] +
    HEX_TABLE[bytes[7]] +
    "-" +
    HEX_TABLE[bytes[8]] +
    HEX_TABLE[bytes[9]] +
    "-" +
    HEX_TABLE[bytes[10]] +
    HEX_TABLE[bytes[11]] +
    HEX_TABLE[bytes[12]] +
    HEX_TABLE[bytes[13]] +
    HEX_TABLE[bytes[14]] +
    HEX_TABLE[bytes[15]]
  );
}

export function uuidv7(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  const ts = BigInt(Date.now());
  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);

  bytes[6] = 0x70 | (bytes[6] & 0x0f); // version 7
  bytes[8] = 0x80 | (bytes[8] & 0x3f); // variant 10

  return bytesToUuidHex(bytes);
}

export function uuidv4(): string {
  return crypto.randomUUID();
}

/**
 * Deterministic UUID derived from the given parts via SHA-256 (a "v5-style"
 * ID: same inputs always produce the same id). Used for docs/protocol.md
 * §8.3 history visit identity, so that independently re-derived visit
 * events (e.g. after a local rebuild) collide on the same objectId instead
 * of duplicating.
 */
// Shared encoder: deterministicUuid runs once per history visit (tens of
// thousands of times per backfill) — allocating a TextEncoder per call
// is pure overhead; it is stateless and safe to reuse.
const uuidTextEncoder = new TextEncoder();

export async function deterministicUuid(...parts: string[]): Promise<string> {
  const data = uuidTextEncoder.encode(parts.join("\0"));
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest).slice(0, 16);
  bytes[6] = 0x50 | (bytes[6] & 0x0f); // version 5-style marker
  bytes[8] = 0x80 | (bytes[8] & 0x3f); // variant 10
  return bytesToUuidHex(bytes);
}
