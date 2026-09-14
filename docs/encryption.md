# HelixSync Encryption Model

HelixSync uses end-to-end encryption (E2E) by default (`encryptionVersion >= 1`).
Production deployments MUST enable encryption enforcement (`REQUIRE_ENCRYPTION=true`
enforced server-side, see §7). Plaintext payloads (`encryptionVersion: 0`) are
supported only for local testing and debugging, and are explicitly **not
production-ready**.

This document is normative for both the extension (encrypt/decrypt) and the
server (opaque storage). No implementation may deviate from the primitives
listed here. Do not invent cryptography — only vetted, audited library
implementations of the primitives below may be used:

- Rust: `chacha20poly1305`, `argon2`, `rand_core` (OS CSPRNG via
  `getrandom`/`OsRng`).
- TypeScript/extension: WebCrypto (`crypto.subtle`) for HKDF-SHA256 key
  derivation, plus `@noble/ciphers` (XChaCha20-Poly1305) and `@noble/hashes`
  (Argon2id, CSPRNG) — independently audited, pure-TypeScript
  implementations.

---

## 1. Key Hierarchy

```text
User encryption root key (REK)
        |
        +-- sync data encryption key (SDEK), derived/rotatable, actually encrypts payloads
```

- **REK**: a 256-bit symmetric key, derived client-side from the account
  password via Argon2id (§2) — never a random value generated on one device
  and relayed to others. Never leaves any device in plaintext. Never sent
  to or derivable by the server (the server only ever sees the password
  hashed with its own independent Argon2id salt for authentication, and the
  separate `encryption_salt` used for REK derivation — never the password
  itself, and never REK).
- **SDEK**: the key that actually encrypts operation payloads. `SDEK_v1` is
  derived from REK via HKDF-SHA256 with a per-key-version `info` string
  (`"helixsync-sdek-v" || keyVersion`). Rotation (§4) introduces `SDEK_v2`,
  etc., without needing a new REK.

The server persists, per user: `encryption_salt` (random 16 bytes, generated
at registration, `server/migrations/0004`) — never plaintext REK, never SDEK
derivation inputs, never the password itself.

---

## 2. Initial Key Generation (every device, first connection)

```text
1. Client calls POST /api/v1/devices/register with email+password
   (docs/protocol.md §7); the response includes the account's
   `encryptionSalt`.
2. Client computes REK = Argon2id(password, encryptionSalt, params below).
3. Client stores REK in extension-local storage only (IndexedDB `device`
   store), never uploaded.
```

Argon2id parameters follow OWASP's 2023 minimum recommendation: `m=19456`
KiB, `t=2`, `p=1`, 32-byte output (`extension/src/crypto/index.ts::deriveRekFromPassword`).
These are fixed constants, not per-deployment tunables — changing them
changes the derived key, silently locking existing devices out of data
encrypted under the old derivation.

Because REK is a pure function of `(password, encryptionSalt)` and every
device fetches the same `encryptionSalt` from the server, **every device
that successfully authenticates with the account password derives the
identical REK independently** — there is no device-to-device handshake, no
"pending authorization" state, and no relay of key material through the
server at all. Logging in on a second or third device is sufficient to
resume decrypting all synced data.

---

## 3. Adding a Device

There is no separate step: §2 already covers it. A new device registers
with the account's email+password like any other device, receives the same
`encryptionSalt`, and derives the same REK on the spot. No confirmation
from an already-connected device is required or possible.

This trades the "explicit per-device trust decision" property of a
device-to-device key-grant scheme for operational simplicity: anyone who
knows the account password can decrypt the account's data on any device,
immediately. That is an explicit, deliberate design choice for this
project's threat model (a single self-hoster syncing their own devices) —
see §5 for what this implies about password strength and rotation.

---

## 4. Key Rotation

Rotation introduces a new SDEK version without discarding old ones:

```text
old key (SDEK_v(n))
   -> new key (SDEK_v(n+1)) derived via HKDF(REK, info=...v(n+1))
   -> new operations encrypted with SDEK_v(n+1), tagged keyVersion=n+1
   -> existing operations/snapshots remain decryptable because SDEK_v(n)
      is still derivable from REK, which every authorized device still holds
```

Because REK itself is derived (`REK = Argon2id(password, encryptionSalt)`,
§2) rather than randomly generated and stored, there is no separate
"rotate REK while keeping the same password" operation — REK changes
exactly when either input changes:

- **Password change** (`PATCH /api/v1/auth/password` via the web
  dashboard): the `encryption_salt` is left untouched, so a *different*
  password against the *same* salt necessarily derives a *different* REK.
  Every device must reconnect (disconnect and set up again in the
  extension options) to pick up the new REK — until they do, they're still
  holding the old one and can't decrypt anything encrypted after the
  change (and the new REK can't decrypt anything encrypted before it). The
  web dashboard's password-change form warns about this
  (`web/src/pages/Security.tsx`). There is currently no automatic
  re-encryption of historical data across a password change — old data
  encrypted under the pre-change REK stays readable only to a device that
  still holds that old REK.
- **Salt rotation**: regenerating `encryption_salt` server-side would
  force a new REK on next derivation even with the same password. This is not
  currently exposed through the public API.

Key-version metadata (`keyVersion`) travels inside the encryption envelope
(§6) with every payload and identifies which `SDEK_v(n)` (HKDF derivation
from the *current* REK) was used — it does not track which REK generation
produced it. A device that has re-derived a new REK after a password change
cannot distinguish "wrong keyVersion" from "right keyVersion, wrong REK
generation"; both simply fail to decrypt.

---

## 5. Missing Key / Recovery

If a device cannot decrypt a downloaded operation — most commonly because
it was encrypted under a REK derived from a *different* password than the
one currently in effect (§4: a password change on another device) — that single
operation is logged (`console.warn("HelixSync: could not decrypt
operation, skipping", ...)`), marked applied, and skipped
(`extension/src/sync/engine.ts::applyOneRemote`). Sync itself continues
normally: the download cursor still advances and every other operation in
the batch (and everything after it) is still applied.

This is a deliberate trade-off, not an oversight: the alternative —
leaving the operation unapplied and refusing to advance the cursor past it
— would block every operation after it, including new data, from ever
reaching that device again. Losing one object's history locally is preferable to
silently wedging sync forever.

**Reconnecting does not retroactively recover already-skipped data** on
that device — once an operation is marked applied, it's never re-attempted
even after a later reconnect with the correct password, since to this
device it looks identical to an operation it already successfully applied.
The data isn't gone from the server or from any other device that still
holds the correct key for it; it's specifically *this* device that gave up
on *that* operation. The server never sees the password in a recoverable
form, never stores REK, and never assists recovery of historical data
encrypted under a REK that no device can currently re-derive. This is a
deliberate consequence of true E2E encryption, not a bug.

---

## 6. Encryption Envelope

When `encryptionVersion >= 1`, an operation's `payload` field contains:

```json
{
  "v": 1,
  "keyVersion": 3,
  "alg": "xchacha20poly1305",
  "nonce": "base64url...",
  "ciphertext": "base64url...",
  "tag": "base64url..."
}
```

| Field        | Meaning                                                                 |
|--------------|--------------------------------------------------------------------------|
| `v`          | Envelope format version (this document's schema), independent of `encryptionVersion` on the operation, which is the coarse "is this encrypted at all" marker used by the server. |
| `keyVersion` | Which `SDEK_v(n)` was used.                                              |
| `alg`        | Algorithm identifier: `xchacha20poly1305` (extension) or `aes-256-gcm` (wrapped keys at rest, if applicable). |
| `nonce`      | 24-byte XChaCha20 nonce (or 12-byte GCM IV for `aes-256-gcm`), base64url. |
| `ciphertext` | Encrypted plaintext operation payload (the actual bookmark/history/tab fields), base64url. |
| `tag`        | Poly1305/GCM authentication tag, base64url (may be concatenated into `ciphertext` depending on library output; if so this field is omitted and documented as such per `alg`). |

`protocolVersion`, `encryptionVersion`, and `keyVersion` together let any
future client determine exactly how to interpret a stored operation without
guessing.

The server stores `payload` as an opaque JSON/binary blob (Postgres
`jsonb`/`bytea`) and never attempts to interpret it when
`encryptionVersion >= 1`.

---

## 7. Server Enforcement

A server instance configuration flag `REQUIRE_ENCRYPTION` (default `true`
in production configurations) causes the upload endpoint
(§10.2 of `docs/protocol.md`) to reject operations with
`encryptionVersion: 0` with `400 Bad Request` / `encryption_required`. In
local testing or development environments, it can be set to `false` to permit
plaintext payloads, but the server logs a startup warning
(`"HelixSync is running WITHOUT end-to-end encryption enforcement — this is not production-ready"`)
whenever `REQUIRE_ENCRYPTION=false`.
