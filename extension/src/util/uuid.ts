// A lookup table avoids per-byte string allocation: these run thousands of
// times per backfill/snapshot on the single MV3 thread.
const HEX_TABLE = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

function bytesToUuidHex(bytes: Uint8Array): string {
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

/** UUIDv7 (RFC 9562), used for objectId (docs/protocol.md §1.1). Time-ordered
 * for storage locality only: conflict resolution must never rely on it. */
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

const uuidTextEncoder = new TextEncoder();

/** SHA-256-derived ("v5-style") UUID: the same parts always give the same id,
 * so independently re-derived history visits collide instead of duplicating
 * (docs/protocol.md §8.3). */
export async function deterministicUuid(...parts: string[]): Promise<string> {
  const data = uuidTextEncoder.encode(parts.join("\0"));
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest).slice(0, 16);
  bytes[6] = 0x50 | (bytes[6] & 0x0f); // version 5-style marker
  bytes[8] = 0x80 | (bytes[8] & 0x3f); // variant 10
  return bytesToUuidHex(bytes);
}
