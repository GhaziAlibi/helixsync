// Passkey-sealed recovery code (docs/encryption.md §9.5). WebAuthn is used
// only for its PRF output, never to authenticate to the server: challenges are
// random and nothing here is sent anywhere. The seal and its helpers live in
// ../crypto; this file is the browser glue and the local record.
import { randomBytes } from "@noble/hashes/utils.js";
import { fromB64, sealRecoveryCode, toB64, unsealRecoveryCode } from "../crypto";
import { LocalizedError } from "../i18n/localized-error";

export interface PasskeyRecord {
  v: 1;
  email: string;
  serverUrl: string;
  credentialId: string;
  prfSalt: string;
  sealed: string;
  createdAt: string;
}

const STORAGE_KEY = "helixsync.passkey.v1";

function isRecord(value: unknown): value is PasskeyRecord {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    r.v === 1 &&
    ["email", "serverUrl", "credentialId", "prfSalt", "sealed", "createdAt"].every(
      (k) => typeof r[k] === "string" && (r[k] as string).length > 0,
    )
  );
}

/** Parses the text of a passkey rescue file. Throws a readable error if it
 * isn't one. */
export function parseRescueFile(text: string): PasskeyRecord {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new LocalizedError("errors.rescueInvalid");
  }
  if (!isRecord(value)) throw new LocalizedError("errors.rescueInvalid");
  return value;
}

function readAll(): Record<string, PasskeyRecord> {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, unknown>;
    const out: Record<string, PasskeyRecord> = {};
    for (const [email, record] of Object.entries(parsed)) if (isRecord(record)) out[email] = record;
    return out;
  } catch {
    return {};
  }
}

/** The record kept in this browser for `email`, or null. Storage that is
 * blocked or empty reads as no record. */
export function loadPasskeyRecord(email: string): PasskeyRecord | null {
  return readAll()[email.trim().toLowerCase()] ?? null;
}

export function savePasskeyRecord(record: PasskeyRecord): void {
  try {
    const all = readAll();
    all[record.email.trim().toLowerCase()] = record;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // The rescue file is the other copy.
  }
}

export function downloadRescueFile(record: PasskeyRecord): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(record, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "helixsync-passkey-rescue.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Whether to offer passkeys at all: a secure context with WebAuthn, and, where
 * the browser can say, the PRF extension. A browser that can't say is given
 * the benefit of the doubt; enrolment checks the real answer. */
export async function passkeySupported(): Promise<boolean> {
  if (typeof window === "undefined" || !window.isSecureContext) return false;
  if (typeof PublicKeyCredential === "undefined" || !navigator.credentials) return false;
  const getCapabilities = (PublicKeyCredential as unknown as {
    getClientCapabilities?: () => Promise<Record<string, boolean>>;
  }).getClientCapabilities;
  if (!getCapabilities) return true;
  try {
    const caps = await getCapabilities.call(PublicKeyCredential);
    const prf = caps["extension:prf"] ?? caps["prf"];
    return prf !== false;
  } catch {
    return true;
  }
}

/** The browser's own credentials API. Password-manager extensions (Bitwarden,
 * 1Password) replace navigator.credentials on the page, and none of them
 * return the PRF secret. A fresh same-origin frame still has the browser's
 * original, so passkeys are offered by the browser itself (Google Password
 * Manager, phone, security key). */
function nativeCredentials(): CredentialsContainer {
  const native = (fn: unknown) => typeof fn === "function" && /\[native code\]/.test(Function.prototype.toString.call(fn));
  if (native(navigator.credentials.create) && native(navigator.credentials.get)) return navigator.credentials;
  try {
    let frame = document.getElementById("helixsync-native-credentials") as HTMLIFrameElement | null;
    if (!frame) {
      frame = document.createElement("iframe");
      frame.id = "helixsync-native-credentials";
      frame.style.display = "none";
      frame.setAttribute("aria-hidden", "true");
      document.body.appendChild(frame);
    }
    const inner = frame.contentWindow?.navigator.credentials;
    if (inner) return inner;
  } catch {
    // Fall through to the page's own API.
  }
  return navigator.credentials;
}

/** Turns the browser's terse WebAuthn errors into something a person can act on. */
export function passkeyError(err: unknown): Error {
  const name = err instanceof DOMException || err instanceof Error ? err.name : "";
  switch (name) {
    case "NotAllowedError":
      return new LocalizedError("errors.passkeyCancelled");
    case "InvalidStateError":
      return new LocalizedError("errors.passkeyExists");
    case "NotSupportedError":
      return new LocalizedError("errors.passkeyNotSupported");
    case "SecurityError":
      return new LocalizedError("errors.passkeyInsecure");
    case "AbortError":
      return new LocalizedError("errors.passkeyAborted");
    default:
      return err instanceof Error && err.message ? err : new LocalizedError("errors.passkeyUnused");
  }
}

async function ceremony<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    throw passkeyError(err);
  }
}

interface PrfExtensionResults {
  prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } };
}

function prfInput(salt: Uint8Array): AuthenticationExtensionsClientInputs {
  return { prf: { eval: { first: salt } } } as unknown as AuthenticationExtensionsClientInputs;
}

/** Asks the passkey for its PRF output over `prfSalt`: one fingerprint / OS
 * PIN prompt. */
export async function getPasskeyPrf(credentialId: string, prfSalt: string): Promise<Uint8Array> {
  const assertion = (await ceremony(() => nativeCredentials().get({
    publicKey: {
      challenge: randomBytes(32) as BufferSource,
      rpId: window.location.hostname,
      allowCredentials: [{ type: "public-key", id: fromB64(credentialId) as BufferSource }],
      userVerification: "required",
      extensions: prfInput(fromB64(prfSalt)),
      timeout: 120000,
    },
  }))) as PublicKeyCredential | null;
  const first = (assertion?.getClientExtensionResults() as PrfExtensionResults | undefined)?.prf?.results?.first;
  if (!first) throw new LocalizedError("errors.passkeyNoSecret");
  return new Uint8Array(first);
}

/** Creates a passkey for the dashboard's hostname and returns its id, the PRF
 * salt used, and the PRF output. */
async function createPasskey(
  email: string,
): Promise<{ credentialId: string; prfSalt: string; prfOutput: Uint8Array }> {
  const salt = randomBytes(32);
  const prfSalt = toB64(salt);
  const credential = (await ceremony(() => nativeCredentials().create({
    publicKey: {
      rp: { id: window.location.hostname, name: "HelixSync" },
      user: { id: randomBytes(16) as BufferSource, name: email, displayName: email },
      challenge: randomBytes(32) as BufferSource,
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
      // Only asks to enable PRF; the output is read with get() below. Passing
      // eval here makes some providers drop the extension altogether.
      extensions: { prf: {} } as unknown as AuthenticationExtensionsClientInputs,
      timeout: 120000,
    },
  }))) as PublicKeyCredential | null;
  if (!credential) throw new LocalizedError("errors.passkeyNotCreated");

  const prf = (credential.getClientExtensionResults() as PrfExtensionResults).prf;
  // Only an explicit "no" stops here: some providers say nothing at creation
  // and answer on get(), which is the real test.
  if (prf?.enabled === false) {
    throw new LocalizedError("errors.passkeyNoPrf");
  }
  const credentialId = toB64(new Uint8Array(credential.rawId));
  // Some authenticators return the output only on a later get().
  const prfOutput = prf?.results?.first
    ? new Uint8Array(prf?.results.first)
    : await getPasskeyPrf(credentialId, prfSalt);
  return { credentialId, prfSalt, prfOutput };
}

/** Creates a passkey and seals `code` under it. */
export async function sealWithNewPasskey(email: string, code: string): Promise<PasskeyRecord> {
  const { credentialId, prfSalt, prfOutput } = await createPasskey(email);
  return {
    v: 1,
    email: email.trim().toLowerCase(),
    serverUrl: window.location.origin,
    credentialId,
    prfSalt,
    sealed: await sealRecoveryCode(prfOutput, code, email, credentialId),
    createdAt: new Date().toISOString(),
  };
}

/** Seals a NEW recovery code under the passkey already in `record` (one
 * prompt). */
export async function resealWithPasskey(record: PasskeyRecord, code: string): Promise<PasskeyRecord> {
  const prfOutput = await getPasskeyPrf(record.credentialId, record.prfSalt);
  return {
    ...record,
    sealed: await sealRecoveryCode(prfOutput, code, record.email, record.credentialId),
    createdAt: new Date().toISOString(),
  };
}

/** Unseals the recovery code with the passkey (one prompt). */
export async function unsealWithPasskey(record: PasskeyRecord): Promise<string> {
  const prfOutput = await getPasskeyPrf(record.credentialId, record.prfSalt);
  return unsealRecoveryCode(prfOutput, record.sealed, record.email, record.credentialId);
}
