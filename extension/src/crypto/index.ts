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

export async function ensureCryptoReady(): Promise<void> {
  // No async WASM init needed with pure-TS noble libraries; kept as an
  // async no-op so call sites (written against a libsodium-style
  // lifecycle) don't need to change if a WASM backend is reintroduced later.
}

function toB64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const withPadding = padded + "=".repeat((4 - (padded.length % 4)) % 4);
  const binary = atob(withPadding);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
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
  const info = new TextEncoder().encode(`helixsync-sdek-v${keyVersion}`);
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
  sdekCache.set(cacheKey, sdek);
  return sdek;
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
  const nonce = randomBytes(24);
  const message = new TextEncoder().encode(JSON.stringify(plaintext));
  const ciphertext = xchacha20poly1305(key, nonce).encrypt(message);
  return {
    v: 1,
    keyVersion,
    alg: "xchacha20poly1305",
    nonce: toB64(nonce),
    ciphertext: toB64(ciphertext),
  };
}

export async function decryptPayload(
  envelope: EncryptionEnvelope,
  rekB64: string,
): Promise<unknown> {
  const key = await deriveSdekBytes(rekB64, envelope.keyVersion);
  const plaintext = xchacha20poly1305(key, fromB64(envelope.nonce)).decrypt(fromB64(envelope.ciphertext));
  return JSON.parse(new TextDecoder().decode(plaintext));
}
