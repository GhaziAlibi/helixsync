// E2E encryption per docs/encryption.md. No custom cryptography:
// XChaCha20-Poly1305 AEAD and Argon2id come from @noble/ciphers/@noble/hashes
// — independently audited, widely used pure-TS implementations (chosen over
// libsodium-wrappers, whose published ESM build has a broken cross-package
// import that bundlers such as Vite cannot resolve). HKDF-SHA256 key
// derivation uses WebCrypto directly (available in MV3 service workers).
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { argon2idAsync } from "@noble/hashes/argon2.js";
import { randomBytes } from "@noble/hashes/utils.js";

export interface EncryptionEnvelope {
  v: 1;
  keyVersion: number;
  alg: "xchacha20poly1305";
  nonce: string;
  ciphertext: string;
}

// Shared codecs: encrypt/decrypt run per operation (thousands of times per
// backfill/snapshot), and allocating a new TextEncoder/TextDecoder per call
// is pure overhead — both are stateless and safe to reuse across calls.
const sharedTextEncoder = new TextEncoder();
const sharedTextDecoder = new TextDecoder();

export async function ensureCryptoReady(): Promise<void> {
  // No async WASM init needed with pure-TS noble libraries; kept as an
  // async no-op so call sites (written against a libsodium-style
  // lifecycle) don't need to change if a WASM backend is reintroduced later.
}

// Chunk size for String.fromCharCode(...chunk) below: spreading a whole
// large Uint8Array as call arguments can exceed the JS engine's max
// call-argument count (the exact limit is undocumented and varies by
// engine). 8192 is comfortably under any realistic engine limit while
// still batching far fewer string concatenations than a per-byte loop.
// Retuning this is not free: 32K/64K chunk sizes were measured *slower*
// than 8192 (24ms vs 17ms on a 1.88MB buffer) — larger chunks mean fewer
// but bigger String.fromCharCode.apply calls, which loses.
const B64_CHUNK_SIZE = 8192;

function base64UrlEncode(binary: string): string {
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Fallback codec: the original per-byte-chunked btoa/atob path, kept
// verbatim as the universal-compatibility branch below.
export function toB64Fallback(bytes: Uint8Array): string {
  // Fast path for the common small-payload case (bookmark/tab/history
  // payloads are typically a few hundred bytes): skip subarray slicing.
  // Uses .apply (indexed array-like access) rather than spread (...bytes,
  // iterator protocol): measured ~3x faster in V8 for these sizes at
  // identical output (see toB64 reference tests + perf-audit BENCH-B).
  if (bytes.length <= B64_CHUNK_SIZE) {
    return base64UrlEncode(String.fromCharCode.apply(null, bytes as unknown as number[]));
  }
  let binary = "";
  for (let i = 0; i < bytes.length; i += B64_CHUNK_SIZE) {
    const chunk = bytes.subarray(i, i + B64_CHUNK_SIZE);
    binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return base64UrlEncode(binary);
}

export function fromB64Fallback(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const withPadding = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(withPadding);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Native Uint8Array.prototype.toBase64/fromBase64 (Chrome 133+) measure
// 240x/20.9x faster than the btoa/atob chunked fallback above (see
// docs/encryption.md perf notes), but manifest.json declares
// minimum_chrome_version 116, which predates them — and neither node 20
// (CI, .github/workflows/release.yml) nor node 22 (local dev) implements
// them either, so this can never be exercised by a plain feature-detect
// running in CI. Never version-gate this; always feature-detect at
// runtime, on the real device where the methods actually exist.
//
// The runtime self-check below is what actually protects production: it
// verifies the native implementation against fixed vectors (chosen to hit
// alphabet indices 62/63, i.e. "-"/"_", exactly where a wrong or missing
// `alphabet` option would diverge) before ever trusting it, and falls back
// permanently on any mismatch or throw. This was verified byte-identical
// to the fallback codec on a 1.88MB buffer in Chromium 148 — that one-time
// browser check can't be automated in CI (see above), so it's recorded
// here instead.
const B64_CONFORMANCE_VECTORS: ReadonlyArray<readonly [number[], string]> = [
  [[], ""],
  [[0x00], "AA"],
  [[0x00, 0x00], "AAA"],
  [[0x00, 0x00, 0x00], "AAAA"],
  [[0xfb, 0xef, 0xbe], "----"],
  [[0xff, 0xff, 0xff], "____"],
  [[0x48, 0x65, 0x6c, 0x69, 0x78, 0x53, 0x79, 0x6e, 0x63], "SGVsaXhTeW5j"],
  [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], "AAECAwQFBgcICQoLDA0ODw"],
  [
    [0xf0, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa, 0xfb, 0xfc, 0xfd, 0xfe, 0xff],
    "8PHy8_T19vf4-fr7_P3-_w",
  ],
];

function nativeB64Conforms(): boolean {
  const proto = Uint8Array.prototype as { toBase64?: (o?: unknown) => string };
  const ctor = Uint8Array as unknown as { fromBase64?: (s: string, o?: unknown) => Uint8Array };
  if (typeof proto.toBase64 !== "function" || typeof ctor.fromBase64 !== "function") return false;
  try {
    for (const [bytes, expected] of B64_CONFORMANCE_VECTORS) {
      const input = Uint8Array.from(bytes);
      if (proto.toBase64.call(input, { alphabet: "base64url", omitPadding: true }) !== expected) return false;
      const back = ctor.fromBase64(expected, { alphabet: "base64url" });
      if (back.length !== input.length) return false;
      for (let i = 0; i < back.length; i++) if (back[i] !== input[i]) return false;
    }
    return true;
  } catch {
    return false; // a throwing native implementation is a non-conforming one
  }
}

let nativeOk: boolean | null = null; // lazily computed once, cost is nine sub-microsecond conversions
function useNative(): boolean {
  if (nativeOk === null) {
    nativeOk = nativeB64Conforms();
    if (!nativeOk && typeof (Uint8Array.prototype as { toBase64?: unknown }).toBase64 === "function") {
      console.warn("HelixSync: native base64 present but non-conforming — using fallback codec");
    }
  }
  return nativeOk;
}

/** Test-only: clears the cached detection so a test can install or remove a
 *  polyfill and re-run the self-check. Same convention as
 *  setBulkChunkUploadDelayMsForTesting. */
export function resetB64DetectionForTesting(): void {
  nativeOk = null;
}

/** Test-only: which codec the self-check settled on. */
export function activeB64ImplForTesting(): "native" | "fallback" {
  return useNative() ? "native" : "fallback";
}

// TypeScript 5.9's bundled lib.*.d.ts (checked: no es2024/esnext variant
// declares them) has no typings for these methods yet, so every access goes
// through the same cast shape as nativeB64Conforms above rather than a
// direct method call.
type NativeB64Proto = { toBase64(o: { alphabet: "base64url"; omitPadding: boolean }): string };
type NativeB64Ctor = { fromBase64(s: string, o: { alphabet: "base64url" }): Uint8Array };

export function toB64(bytes: Uint8Array): string {
  return useNative()
    ? (bytes as unknown as NativeB64Proto).toBase64({ alphabet: "base64url", omitPadding: true })
    : toB64Fallback(bytes);
}

export function fromB64(value: string): Uint8Array {
  return useNative()
    ? (Uint8Array as unknown as NativeB64Ctor).fromBase64(value, { alphabet: "base64url" })
    : fromB64Fallback(value);
}

/** docs/encryption.md §2: derive the account's encryption root key (REK)
 * directly from the password via Argon2id, keyed to a random per-account
 * salt the server hands back at registration/connect time
 * (`users.encryption_salt`, server/migrations/0004). Any device that knows
 * the email+password recomputes the exact same REK locally — there is no
 * device-to-device handshake or relay to fall out of sync. Cost parameters
 * follow OWASP's 2023 Argon2id minimum recommendation (m=19MiB, t=2, p=1);
 * changing them changes the derived key, so they must never be tuned per
 * deployment. */
export async function deriveRekFromPassword(password: string, saltB64: string): Promise<string> {
  const salt = fromB64(saltB64);
  const key = await argon2idAsync(password, salt, { t: 2, m: 19456, p: 1, dkLen: 32 });
  return toB64(key);
}

// deriveSdekBytes is a pure function of (rek, keyVersion) — the same two
// inputs always produce the same SDEK. Without caching, a bulk operation
// (encrypting/decrypting thousands of backfilled items) re-runs the same
// WebCrypto HKDF derivation once per item for a result that's identical
// every time. Keyed by the full rekB64 rather than a truncation since a
// cache collision here would mean encrypting/decrypting under the wrong key.
// Bounded: keys are `rek:keyVersion` (1-2 live values in practice), but an
// unbounded Map would retain every REK ever seen across password changes
// for the SW lifetime. FIFO eviction keeps memory constant.
const MAX_SDEK_CACHE_SIZE = 8;
const sdekCache = new Map<string, Uint8Array>();

/** docs/encryption.md §1: derive SDEK_v(n) from REK via HKDF-SHA256, using
 * WebCrypto (available in the MV3 service worker context). */
async function deriveSdekBytes(rekB64: string, keyVersion: number): Promise<Uint8Array> {
  const cacheKey = `${rekB64}:${keyVersion}`;
  const cached = sdekCache.get(cacheKey);
  if (cached) return cached;

  const rek = fromB64(rekB64);
  const ikm = await crypto.subtle.importKey("raw", rek.buffer as ArrayBuffer, "HKDF", false, [
    "deriveBits",
  ]);
  const info = sharedTextEncoder.encode(`helixsync-sdek-v${keyVersion}`);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info,
    },
    ikm,
    256,
  );
  const sdek = new Uint8Array(bits);
  if (sdekCache.size >= MAX_SDEK_CACHE_SIZE) {
    // Map preserves insertion order — drop the oldest key first.
    const oldest = sdekCache.keys().next();
    if (!oldest.done) sdekCache.delete(oldest.value);
  }
  sdekCache.set(cacheKey, sdek);
  return sdek;
}

/** Hoisted SDEK for bulk crypto loops. `deriveSdekBytes` is cached, but
 * calling it per operation still pays an async hop plus a
 * `${rekB64}:${keyVersion}` string allocation per item — thousands of times
 * per backfill/snapshot. Bulk callers (sync/engine.ts batch encrypt/decrypt
 * loops) derive once up front and use the sync cores below instead. */
export async function getSdek(rekB64: string, keyVersion: number): Promise<Uint8Array> {
  return deriveSdekBytes(rekB64, keyVersion);
}

/** Byte-level AEAD core: encrypts already-serialized plaintext bytes. The
 * one XChaCha20-Poly1305 encrypt call site for this whole module —
 * `encryptWithSdek` below delegates here after its own JSON.stringify+encode
 * step. Exists as its own export (spec §D) so bulk.ts's compressed segment
 * path (plaintext bytes -> deflate-raw -> here) doesn't have to route
 * through a JSON.stringify of already-compressed bytes just to reuse this
 * function. */
export function encryptBytesWithSdek(
  plaintext: Uint8Array,
  sdek: Uint8Array,
  keyVersion: number,
): EncryptionEnvelope {
  const nonce = randomBytes(24);
  const ciphertext = xchacha20poly1305(sdek, nonce).encrypt(plaintext);
  return {
    v: 1,
    keyVersion,
    alg: "xchacha20poly1305",
    nonce: toB64(nonce),
    ciphertext: toB64(ciphertext),
  };
}

/** Byte-level AEAD core: decrypts to raw plaintext bytes, no JSON.parse.
 * The one XChaCha20-Poly1305 decrypt call site for this whole module.
 * Throws on auth failure, same as `decryptPayload`. */
export function decryptBytesWithSdek(envelope: EncryptionEnvelope, sdek: Uint8Array): Uint8Array {
  return xchacha20poly1305(sdek, fromB64(envelope.nonce)).decrypt(fromB64(envelope.ciphertext));
}

/** Sync core of `encryptPayload` with an already-derived SDEK — no async
 * key derivation, no cache-key allocation. */
export function encryptWithSdek(
  plaintext: unknown,
  sdek: Uint8Array,
  keyVersion: number,
): EncryptionEnvelope {
  return encryptBytesWithSdek(sharedTextEncoder.encode(JSON.stringify(plaintext)), sdek, keyVersion);
}

/** Sync core of `decryptPayload` with an already-derived SDEK. Throws on
 * auth failure, same as `decryptPayload`. */
export function decryptWithSdek(envelope: EncryptionEnvelope, sdek: Uint8Array): unknown {
  return JSON.parse(sharedTextDecoder.decode(decryptBytesWithSdek(envelope, sdek)));
}

/** docs/encryption.md §6: encrypt an operation payload into the envelope
 * format. `encryptionVersion` on the operation itself stays a coarse
 * "is this encrypted" marker; `keyVersion` inside the envelope says which
 * SDEK derivation to use. */
export async function encryptPayload(
  plaintext: unknown,
  rekB64: string,
  keyVersion: number,
): Promise<EncryptionEnvelope> {
  const key = await deriveSdekBytes(rekB64, keyVersion);
  return encryptWithSdek(plaintext, key, keyVersion);
}

export async function decryptPayload(
  envelope: EncryptionEnvelope,
  rekB64: string,
): Promise<unknown> {
  const key = await deriveSdekBytes(rekB64, envelope.keyVersion);
  return decryptWithSdek(envelope, key);
}
