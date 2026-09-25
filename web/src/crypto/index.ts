// SEC-01 / docs/encryption.md: the account password never reaches the
// server. This module mirrors the derive/wrap/unwrap primitives in
// extension/src/crypto/index.ts (same info strings, same algorithms) so an
// account created on one side is usable from the other — but only the
// subset the dashboard actually needs (no SDEK/bulk/base64-perf code; the
// web app never encrypts or decrypts synced payloads itself).
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { argon2idAsync } from "@noble/hashes/argon2.js";
import { randomBytes } from "@noble/hashes/utils.js";

const sharedTextEncoder = new TextEncoder();

function base64UrlEncode(binary: string): string {
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function toB64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return base64UrlEncode(binary);
}

export function fromB64(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const withPadding = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(withPadding);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Argon2id cost parameters for deriving the master key from the password
 * (docs/encryption.md §2) — same shape and default as
 * extension/src/crypto/index.ts::KdfParams/DEFAULT_KDF_PARAMS. */
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

/** SEC-14: reject server-supplied Argon2id parameters outside the bounds
 * in docs/encryption.md §2 (below the defaults, or implausibly high), and
 * reject a salt that isn't a plausible size. Mirrors
 * extension/src/crypto/index.ts::assertSaneKdfParams. */
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

/** SEC-01: derive the master key `M` from the password via Argon2id, keyed
 * to `kdfSalt` (per-account, server-returned by `POST /auth/prelogin`). `M`
 * never leaves the client and is never sent anywhere. */
export async function deriveMasterKey(
  password: string,
  kdfSaltB64: string,
  kdfParams: KdfParams,
): Promise<Uint8Array> {
  const salt = fromB64(kdfSaltB64);
  assertSaneKdfParams(kdfParams, salt);
  return argon2idAsync(password, salt, { t: kdfParams.t, m: kdfParams.m, p: kdfParams.p, dkLen: 32 });
}

/** The only secret ever sent to the server in place of a password. */
export async function deriveAuthKey(masterKey: Uint8Array): Promise<string> {
  return toB64(await hkdfSha256(masterKey, "helixsync-auth-v1"));
}

/** Key-encryption key: wraps/unwraps the account key. Never leaves the
 * client. */
export async function deriveKek(masterKey: Uint8Array): Promise<Uint8Array> {
  return hkdfSha256(masterKey, "helixsync-kek-v1");
}

/** A fresh, random 32-byte account key (AK) — generated once, at account
 * creation. */
export function generateAccountKey(): Uint8Array {
  return randomBytes(32);
}

/** A fresh per-account KDF salt — same size as the server's old
 * `encryption_salt` (server/src/crypto/mod.rs::generate_encryption_salt,
 * now removed) that this replaces the client-side generation of. Used at
 * registration and again on every password change (docs/encryption.md §4),
 * since a new password gets a new salt rather than reusing the old one. */
export function generateKdfSalt(): string {
  return toB64(randomBytes(16));
}

interface WrappedAccountKeyEnvelope {
  v: 1;
  alg: "xchacha20poly1305";
  nonce: string;
  ciphertext: string;
}

/** Encrypts `accountKey` under `kek` into the opaque string the server
 * stores as `wrappedAK`/`wrappedAccountKey`. No AAD — see
 * extension/src/crypto/index.ts::wrapAccountKey for why (same reasoning
 * applies here: nothing stable to bind at registration time, security
 * comes from the CSPRNG nonce). */
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

/** Inverse of `wrapAccountKey`. Throws (AEAD failure) if `kek` is wrong. */
export function unwrapAccountKey(kek: Uint8Array, wrapped: string): Uint8Array {
  const envelope = JSON.parse(wrapped) as WrappedAccountKeyEnvelope;
  return xchacha20poly1305(kek, fromB64(envelope.nonce)).decrypt(fromB64(envelope.ciphertext));
}
