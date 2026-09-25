import { describe, expect, it } from "vitest";
import {
  DEFAULT_KDF_PARAMS,
  deriveAuthKey,
  deriveKek,
  deriveMasterKey,
  fromB64,
  generateAccountKey,
  generateKdfSalt,
  toB64,
  unwrapAccountKey,
  wrapAccountKey,
} from "./index";

const SALT = toB64(Uint8Array.from({ length: 16 }, (_, i) => i + 1));
const PASSWORD = "correct horse battery staple";

describe("base64url helpers", () => {
  it("round-trips arbitrary bytes without padding or the standard alphabet's + / characters", () => {
    for (const length of [0, 1, 2, 3, 31, 32, 33, 255]) {
      const bytes = crypto.getRandomValues(new Uint8Array(length));
      const encoded = toB64(bytes);
      expect(encoded).not.toMatch(/[+/=]/);
      expect(fromB64(encoded)).toEqual(bytes);
    }
  });

  it("uses the URL-safe alphabet at indices 62 and 63", () => {
    expect(toB64(Uint8Array.from([0xfb, 0xef, 0xbe]))).toBe("----");
    expect(toB64(Uint8Array.from([0xff, 0xff, 0xff]))).toBe("____");
  });

  it("accepts padded input as well", () => {
    expect(fromB64("AA==")).toEqual(Uint8Array.from([0]));
  });
});

describe("generateKdfSalt / generateAccountKey", () => {
  it("makes a 16-byte salt, different every time", () => {
    const a = generateKdfSalt();
    expect(fromB64(a)).toHaveLength(16);
    expect(generateKdfSalt()).not.toBe(a);
  });

  it("makes a 32-byte account key, different every time", () => {
    const a = generateAccountKey();
    expect(a).toHaveLength(32);
    expect(generateAccountKey()).not.toEqual(a);
  });
});

describe("key derivation (Argon2id + HKDF)", () => {
  it("is deterministic and yields distinct auth and wrap keys from one master key", async () => {
    const master = await deriveMasterKey(PASSWORD, SALT, DEFAULT_KDF_PARAMS);
    expect(master).toHaveLength(32);
    expect(await deriveMasterKey(PASSWORD, SALT, DEFAULT_KDF_PARAMS)).toEqual(master);

    const authKey = await deriveAuthKey(master);
    const kek = await deriveKek(master);
    expect(fromB64(authKey)).toHaveLength(32);
    expect(kek).toHaveLength(32);
    // The server only ever sees authKey; it must reveal nothing about the KEK.
    expect(authKey).not.toBe(toB64(kek));
    expect(authKey).not.toBe(toB64(master));
  }, 30_000);

  it("derives a different master key for a different password or salt", async () => {
    const base = await deriveMasterKey(PASSWORD, SALT, DEFAULT_KDF_PARAMS);
    expect(await deriveMasterKey("a different password", SALT, DEFAULT_KDF_PARAMS)).not.toEqual(base);
    expect(await deriveMasterKey(PASSWORD, generateKdfSalt(), DEFAULT_KDF_PARAMS)).not.toEqual(base);
  }, 30_000);

  // Pins the derivation to the extension's implementation (same vector is
  // produced by extension/src/crypto/index.ts): an account registered from
  // the dashboard must sign in from the extension and the reverse, so a
  // change on one side only would lock people out.
  it("matches the extension's derivation byte for byte", async () => {
    const master = await deriveMasterKey(PASSWORD, SALT, DEFAULT_KDF_PARAMS);
    expect(toB64(master)).toBe("u7HkQc8NFEyI1fGa9gfr7DIUnvi_UM_saRdXcmsbkMA");
    expect(await deriveAuthKey(master)).toBe("tqH-3QMYG1E9dVNKuW_VspmWeN5oe86XQf6RarodStQ");
    expect(toB64(await deriveKek(master))).toBe("syzyV5bhdKf7eqOUs6oIErx1Lbj-QfJzwIv4IDQyFxA");
  }, 30_000);
});

describe("account key wrap / unwrap", () => {
  it("round-trips the account key under the same KEK", async () => {
    const kek = await deriveKek(await deriveMasterKey(PASSWORD, SALT, DEFAULT_KDF_PARAMS));
    const accountKey = generateAccountKey();

    const wrapped = wrapAccountKey(kek, accountKey);
    expect(unwrapAccountKey(kek, wrapped)).toEqual(accountKey);

    const envelope = JSON.parse(wrapped) as { v: number; alg: string };
    expect(envelope.v).toBe(1);
    expect(envelope.alg).toBe("xchacha20poly1305");
  }, 30_000);

  it("wraps the same key differently each time (random nonce)", () => {
    const kek = crypto.getRandomValues(new Uint8Array(32));
    const accountKey = generateAccountKey();
    expect(wrapAccountKey(kek, accountKey)).not.toBe(wrapAccountKey(kek, accountKey));
  });

  it("fails to unwrap with the KEK of a different password", async () => {
    const kekRight = await deriveKek(await deriveMasterKey(PASSWORD, SALT, DEFAULT_KDF_PARAMS));
    const kekWrong = await deriveKek(await deriveMasterKey("not the password", SALT, DEFAULT_KDF_PARAMS));
    const wrapped = wrapAccountKey(kekRight, generateAccountKey());

    expect(() => unwrapAccountKey(kekWrong, wrapped)).toThrow();
  }, 30_000);

  it("fails to unwrap a tampered ciphertext", () => {
    const kek = crypto.getRandomValues(new Uint8Array(32));
    const envelope = JSON.parse(wrapAccountKey(kek, generateAccountKey())) as { ciphertext: string };
    const bytes = fromB64(envelope.ciphertext);
    bytes[0] ^= 0x01;
    const tampered = JSON.stringify({ ...envelope, ciphertext: toB64(bytes) });

    expect(() => unwrapAccountKey(kek, tampered)).toThrow();
  });
});

describe("unsafe KDF parameters from the server are rejected (SEC-14)", () => {
  const goodSalt = generateKdfSalt();
  const reject = (params: { m: number; t: number; p: number }, salt = goodSalt) =>
    expect(deriveMasterKey(PASSWORD, salt, params)).rejects.toThrow("unsafe key-derivation parameters");

  it("rejects a memory cost below the floor, which would make offline cracking cheap", async () => {
    await reject({ ...DEFAULT_KDF_PARAMS, m: 1024 });
  });
  it("rejects a time cost below the floor", async () => {
    await reject({ ...DEFAULT_KDF_PARAMS, t: 1 });
  });
  it("rejects parallelism below the floor", async () => {
    await reject({ ...DEFAULT_KDF_PARAMS, p: 0 });
  });
  it("rejects costs above the ceiling, which would freeze the browser", async () => {
    await reject({ ...DEFAULT_KDF_PARAMS, m: 262145 });
    await reject({ ...DEFAULT_KDF_PARAMS, t: 11 });
    await reject({ ...DEFAULT_KDF_PARAMS, p: 5 });
  });
  it("rejects non-integer parameters", async () => {
    await reject({ ...DEFAULT_KDF_PARAMS, t: 2.5 });
    await reject({ ...DEFAULT_KDF_PARAMS, m: Number.NaN });
  });
  it("rejects an implausibly short or long salt", async () => {
    await reject(DEFAULT_KDF_PARAMS, toB64(new Uint8Array(15)));
    await reject(DEFAULT_KDF_PARAMS, toB64(new Uint8Array(65)));
  });
  it("accepts the documented floor itself", async () => {
    await expect(deriveMasterKey(PASSWORD, goodSalt, DEFAULT_KDF_PARAMS)).resolves.toHaveLength(32);
  }, 30_000);
});
