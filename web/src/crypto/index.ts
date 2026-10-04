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

// Crockford base32: no I, L, O or U, so a code read aloud or retyped from
// paper survives the usual mix-ups (see `parseRecoveryCode`).
const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Crockford base32 of `bytes`, whose bit length must be a multiple of 5
 * (the recovery code's 20 bytes and the fingerprint's 10 both are). */
function toCrockford(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

function groupsOfFour(text: string): string {
  return text.match(/.{1,4}/g)!.join("-");
}

const RECOVERY_CODE_BYTES = 20;
const RECOVERY_CODE_CHARS = (RECOVERY_CODE_BYTES * 8) / 5;

/** A fresh recovery code (docs/encryption.md §9.1): 160 random bits shown as
 * eight groups of four Crockford base32 characters, `XXXX-XXXX-…`. High
 * entropy, so it needs no Argon2 stretching, unlike the password. */
export function generateRecoveryCode(): string {
  return groupsOfFour(toCrockford(randomBytes(RECOVERY_CODE_BYTES)));
}

/** The 20 bytes behind a typed recovery code. Accepts lowercase, spaces and
 * dashes anywhere, and reads I and L as 1 and O as 0. Throws on anything
 * else, or on the wrong length. */
export function parseRecoveryCode(input: string): Uint8Array {
  const normalized = input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
  if (normalized.length !== RECOVERY_CODE_CHARS) {
    throw new Error("A recovery code has 32 characters.");
  }
  const bytes = new Uint8Array(RECOVERY_CODE_BYTES);
  let bits = 0;
  let value = 0;
  let index = 0;
  for (const char of normalized) {
    const digit = CROCKFORD_ALPHABET.indexOf(char);
    if (digit < 0) {
      throw new Error(`"${char}" can't appear in a recovery code.`);
    }
    value = ((value << 5) | digit) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      bytes[index++] = (value >>> (bits - 8)) & 0xff;
      bits -= 8;
    }
  }
  return bytes;
}

/** The recovery code's counterparts of `authKey` and `KEK`: what the server
 * checks (stored only as a hash) and what wraps the second copy of the
 * account key. Same HKDF as the password path, different info strings. */
export async function deriveRecoveryKeys(code: Uint8Array): Promise<{ authKey: string; kek: Uint8Array }> {
  return {
    authKey: toB64(await hkdfSha256(code, "helixsync-recovery-auth-v1")),
    kek: await hkdfSha256(code, "helixsync-recovery-kek-v1"),
  };
}

const AUTH_REQUEST_LABEL = "helixsync-auth-request-v1";

/** A one-time ECDH P-256 key pair for a login-with-device request
 * (docs/encryption.md §9.2), with the public key in the raw base64url form
 * the server expects. The dashboard only needs the public key, for the
 * fingerprint phrase: an approved dashboard login receives no key. */
export async function generateAuthRequestPublicKey(): Promise<string> {
  const keyPair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  return toB64(new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey)));
}

/** The phrase both sides of a login-with-device request show, so the user
 * can tell their own request from someone else's, or from a key a hostile
 * server swapped in: SHA-256 of a fixed label and the requester's public
 * key, first 80 bits, as `XXXX-XXXX-XXXX-XXXX`. Mirrors
 * extension/src/crypto/index.ts::authRequestFingerprint. */
export async function authRequestFingerprint(publicKeyB64: string): Promise<string> {
  const label = sharedTextEncoder.encode(AUTH_REQUEST_LABEL);
  const publicKey = fromB64(publicKeyB64);
  const input = new Uint8Array(label.length + publicKey.length);
  input.set(label);
  input.set(publicKey, label.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return groupsOfFour(toCrockford(digest.slice(0, 10)));
}
