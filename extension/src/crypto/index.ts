// E2E encryption per docs/encryption.md. No custom cryptography:
// XChaCha20-Poly1305 and Argon2id come from the audited pure-TS @noble
// libraries (libsodium-wrappers' ESM build can't be bundled by Vite), and
// HKDF-SHA256 uses WebCrypto.
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { argon2idAsync } from "@noble/hashes/argon2.js";
import { randomBytes } from "@noble/hashes/utils.js";

/** Format version of every AAD-bound ciphertext envelope: synced operation
 * payloads, snapshot objects and bulk-history segments (docs/encryption.md
 * §6). This is the `v` inside an `EncryptionEnvelope` and nothing else.
 *
 * It is NOT the version of the account-key wrap (`WrappedAccountKeyEnvelope`,
 * which stays 1), the op-level `encryptionVersion` (which only says "this op
 * is encrypted"), or the `v`/`bulkVersion` fields of a bulk-history container
 * and its segment plaintext (src/history/bulk.ts) — those describe the
 * structure of the data, not of the encryption.
 *
 * The format is frozen: version 2 binds the ciphertext to (objectType,
 * objectId, operationType) via the AEAD's associated data. Anything that
 * changes how an envelope is built or authenticated must get a new number. */
export const ENVELOPE_VERSION = 2;

export interface EncryptionEnvelope {
  v: typeof ENVELOPE_VERSION;
  keyVersion: number;
  alg: "xchacha20poly1305";
  nonce: string;
  ciphertext: string;
}

/** An envelope whose `v` this client doesn't understand. Distinct from an
 * authentication failure on purpose: a tampered or wrong-key ciphertext is
 * skipped, but an envelope from a newer (or older, unsupported) format is
 * data this client simply can't read yet, so the sync engine must stop and
 * retry after an update instead of treating it as lost. */
export class UnsupportedEnvelopeVersionError extends Error {
  readonly envelopeVersion: number;

  constructor(envelopeVersion: number) {
    super(
      `Some synced data uses encryption format v${envelopeVersion}, which this version of HelixSync can't read. ` +
        "Update the HelixSync extension to continue syncing.",
    );
    this.name = "UnsupportedEnvelopeVersionError";
    this.envelopeVersion = envelopeVersion;
  }
}

/** Throws `UnsupportedEnvelopeVersionError` if `envelope` is an object whose
 * numeric `v` isn't `ENVELOPE_VERSION`. Anything without a numeric `v` is
 * left to fail normally (it's malformed, not from another format). Only the
 * tag is inspected, so it's cheap enough to run over a whole page of
 * operations or a snapshot before anything is applied. */
export function assertSupportedEnvelopeVersion(envelope: unknown): void {
  if (typeof envelope !== "object" || envelope === null) return;
  const v = (envelope as { v?: unknown }).v;
  if (typeof v === "number" && v !== ENVELOPE_VERSION) throw new UnsupportedEnvelopeVersionError(v);
}

const sharedTextEncoder = new TextEncoder();
const sharedTextDecoder = new TextDecoder();

/** No-op: the noble libraries need no async init. Kept as the lifecycle hook
 * callers await before using crypto. */
export async function ensureCryptoReady(): Promise<void> {}

// Spreading a large Uint8Array into String.fromCharCode can exceed the
// engine's argument limit. 8192 measured faster than 32K/64K chunks.
const B64_CHUNK_SIZE = 8192;

function base64UrlEncode(binary: string): string {
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function toB64Fallback(bytes: Uint8Array): string {
  // `.apply` (indexed access) measured ~3x faster than spread in V8.
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

// Native Uint8Array.toBase64/fromBase64 (Chrome 133+) are far faster, but
// the manifest's minimum is Chrome 116 and CI's Node lacks them, so they are
// feature-detected at runtime, never version-gated. Before being trusted
// they must reproduce these vectors, which cover alphabet indices 62/63
// ("-"/"_") where a wrong `alphabet` option would diverge; any mismatch or
// throw falls back permanently.
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
    return false;
  }
}

let nativeOk: boolean | null = null;
function useNative(): boolean {
  if (nativeOk === null) {
    nativeOk = nativeB64Conforms();
    if (!nativeOk && typeof (Uint8Array.prototype as { toBase64?: unknown }).toBase64 === "function") {
      console.warn("HelixSync: native base64 present but non-conforming — using fallback codec");
    }
  }
  return nativeOk;
}

export function resetB64DetectionForTesting(): void {
  nativeOk = null;
}

export function activeB64ImplForTesting(): "native" | "fallback" {
  return useNative() ? "native" : "fallback";
}

// TypeScript's bundled lib has no typings for the native methods yet.
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

/** Argon2id cost parameters (docs/encryption.md §2), stored per account
 * server-side. The default is OWASP's 2023 minimum. */
export interface KdfParams {
  m: number;
  t: number;
  p: number;
}
export const DEFAULT_KDF_PARAMS: KdfParams = { m: 19456, t: 2, p: 1 };

const KDF_M_MIN = 19456;
const KDF_M_MAX = 262144;
const KDF_T_MIN = 2;
const KDF_T_MAX = 10;
const KDF_P_MIN = 1;
const KDF_P_MAX = 4;
const KDF_SALT_MIN_BYTES = 16;
const KDF_SALT_MAX_BYTES = 64;

/** SEC-14: rejects server-supplied Argon2id parameters or salt outside the
 * bounds in docs/encryption.md §2, so a malicious server can't weaken the KDF. */
function assertSaneKdfParams(kdfParams: KdfParams, salt: Uint8Array): void {
  const { m, t, p } = kdfParams;
  const sane =
    Number.isInteger(m) &&
    m >= KDF_M_MIN &&
    m <= KDF_M_MAX &&
    Number.isInteger(t) &&
    t >= KDF_T_MIN &&
    t <= KDF_T_MAX &&
    Number.isInteger(p) &&
    p >= KDF_P_MIN &&
    p <= KDF_P_MAX &&
    salt.length >= KDF_SALT_MIN_BYTES &&
    salt.length <= KDF_SALT_MAX_BYTES;
  if (!sane) {
    throw new Error("The server returned unsafe key-derivation parameters");
  }
}

async function hkdfSha256(ikmBytes: Uint8Array, info: string, lengthBits = 256): Promise<Uint8Array> {
  const ikm = await crypto.subtle.importKey("raw", ikmBytes.buffer as ArrayBuffer, "HKDF", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: sharedTextEncoder.encode(info),
    },
    ikm,
    lengthBits,
  );
  return new Uint8Array(bits);
}

/** SEC-01 / docs/encryption.md §2: derives the master key M from the password.
 * M never leaves the client; only `deriveAuthKey(M)` is ever sent. */
export async function deriveMasterKey(
  password: string,
  kdfSaltB64: string,
  kdfParams: KdfParams,
): Promise<Uint8Array> {
  const salt = fromB64(kdfSaltB64);
  assertSaneKdfParams(kdfParams, salt);
  return argon2idAsync(password, salt, { t: kdfParams.t, m: kdfParams.m, p: kdfParams.p, dkLen: 32 });
}

/** The only secret sent to the server in place of the password. */
export async function deriveAuthKey(masterKey: Uint8Array): Promise<string> {
  return toB64(await hkdfSha256(masterKey, "helixsync-auth-v1"));
}

/** Key-encryption key that wraps the account key. Never sent anywhere. */
export async function deriveKek(masterKey: Uint8Array): Promise<Uint8Array> {
  return hkdfSha256(masterKey, "helixsync-kek-v1");
}

/** A random 32-byte account key, generated once per account. A password
 * change only re-wraps it (docs/encryption.md §4). */
export function generateAccountKey(): Uint8Array {
  return randomBytes(32);
}

// The account-key wrap is its own format with its own version, unrelated to
// `ENVELOPE_VERSION` (the AAD-bound envelope of synced data); it stays 1.
interface WrappedAccountKeyEnvelope {
  v: 1;
  alg: "xchacha20poly1305";
  nonce: string;
  ciphertext: string;
}

// No AAD: the key is wrapped at registration, before the server has
// assigned a user id, so there is nothing stable and authenticated to bind.
export function wrapAccountKey(kek: Uint8Array, accountKey: Uint8Array): string {
  const nonce = randomBytes(24);
  const ciphertext = xchacha20poly1305(kek, nonce).encrypt(accountKey);
  const envelope: WrappedAccountKeyEnvelope = {
    v: 1,
    alg: "xchacha20poly1305",
    nonce: toB64(nonce),
    ciphertext: toB64(ciphertext),
  };
  return JSON.stringify(envelope);
}

/** Throws (AEAD failure) if `kek` is wrong, i.e. the password was wrong. */
export function unwrapAccountKey(kek: Uint8Array, wrapped: string): Uint8Array {
  const envelope = JSON.parse(wrapped) as WrappedAccountKeyEnvelope;
  return xchacha20poly1305(kek, fromB64(envelope.nonce)).decrypt(fromB64(envelope.ciphertext));
}

// SDEK derivation is pure in (ak, keyVersion). Keyed by the full key (a
// collision would mean using the wrong key) and FIFO-bounded so old account
// keys aren't retained for the worker's lifetime.
const MAX_SDEK_CACHE_SIZE = 8;
const sdekCache = new Map<string, Uint8Array>();

/** Derives SDEK_v(n) from the account key (docs/encryption.md §1). Bulk
 * loops should call this once and use the synchronous `*WithSdek` functions. */
export async function getSdek(akB64: string, keyVersion: number): Promise<Uint8Array> {
  const cacheKey = `${akB64}:${keyVersion}`;
  const cached = sdekCache.get(cacheKey);
  if (cached) return cached;

  const ak = fromB64(akB64);
  const sdek = await hkdfSha256(ak, `helixsync-sdek-v${keyVersion}`);
  if (sdekCache.size >= MAX_SDEK_CACHE_SIZE) {
    const oldest = sdekCache.keys().next();
    if (!oldest.done) sdekCache.delete(oldest.value);
  }
  sdekCache.set(cacheKey, sdek);
  return sdek;
}

// F-02: the AEAD's associated data binds a ciphertext to the metadata the
// server stores next to it in plaintext (objectType, objectId,
// operationType). Those columns are otherwise unauthenticated, so a
// malicious server could relabel an operation (e.g. a bookmark payload
// re-tagged as a "tab create") or splice a ciphertext onto a different
// object without this. JSON-encoding the tuple avoids delimiter ambiguity
// between the three fields.
export function buildOperationAad(objectType: string, objectId: string, operationType: string): Uint8Array {
  return sharedTextEncoder.encode(JSON.stringify([objectType, objectId, operationType]));
}

/** Encrypts already-serialized bytes; the bulk history path uses this
 * directly for compressed segments. `aad` must be the same bytes passed to
 * the matching `decryptBytesWithSdek` call, or decryption fails. */
export function encryptBytesWithSdek(
  plaintext: Uint8Array,
  sdek: Uint8Array,
  keyVersion: number,
  aad: Uint8Array,
): EncryptionEnvelope {
  const nonce = randomBytes(24);
  const ciphertext = xchacha20poly1305(sdek, nonce, aad).encrypt(plaintext);
  return {
    v: ENVELOPE_VERSION,
    keyVersion,
    alg: "xchacha20poly1305",
    nonce: toB64(nonce),
    ciphertext: toB64(ciphertext),
  };
}

/** Throws `UnsupportedEnvelopeVersionError` for any version but
 * `ENVELOPE_VERSION`, and on authentication failure, including a mismatched
 * `aad`. There is deliberately no fallback that reads an envelope without its
 * AAD: that would let a server relabel exactly those ciphertexts (F-02). */
export function decryptBytesWithSdek(envelope: EncryptionEnvelope, sdek: Uint8Array, aad: Uint8Array): Uint8Array {
  assertSupportedEnvelopeVersion(envelope);
  if ((envelope as { v?: unknown }).v !== ENVELOPE_VERSION) {
    throw new Error("malformed encryption envelope: missing version");
  }
  return xchacha20poly1305(sdek, fromB64(envelope.nonce), aad).decrypt(fromB64(envelope.ciphertext));
}

export function encryptWithSdek(
  plaintext: unknown,
  sdek: Uint8Array,
  keyVersion: number,
  aad: Uint8Array,
): EncryptionEnvelope {
  return encryptBytesWithSdek(sharedTextEncoder.encode(JSON.stringify(plaintext)), sdek, keyVersion, aad);
}

/** Throws on authentication failure, including a mismatched `aad`. */
export function decryptWithSdek(envelope: EncryptionEnvelope, sdek: Uint8Array, aad: Uint8Array): unknown {
  return JSON.parse(sharedTextDecoder.decode(decryptBytesWithSdek(envelope, sdek, aad)));
}

/** docs/encryption.md §6. The operation's `encryptionVersion` only marks it
 * as encrypted; the envelope's `keyVersion` selects the SDEK. */
export async function encryptPayload(
  plaintext: unknown,
  akB64: string,
  keyVersion: number,
  aad: Uint8Array,
): Promise<EncryptionEnvelope> {
  const key = await getSdek(akB64, keyVersion);
  return encryptWithSdek(plaintext, key, keyVersion, aad);
}

export async function decryptPayload(
  envelope: EncryptionEnvelope,
  akB64: string,
  aad: Uint8Array,
): Promise<unknown> {
  const key = await getSdek(akB64, envelope.keyVersion);
  return decryptWithSdek(envelope, key, aad);
}
