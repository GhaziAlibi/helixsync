import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildOperationAad, encryptWithSdek, fromB64, generateAccountKey, getSdek, toB64 } from "../crypto";
import { buildRulesetAad } from "../crypto";
import type { DeviceRecord, RulesetsRecord } from "../storage/db";
import vector from "./fixtures/ruleset-vector.json";
import type { RulesetPlaintext } from "./types";

let device: DeviceRecord | undefined;
let record: RulesetsRecord | undefined;
let supported = true;
let served: Array<{ id: string; revision: number; isDefault: boolean; envelope: unknown }> = [];
let failFetch: Error | null = null;
const fetchOwnRulesets = vi.fn(async () => {
  if (failFetch) throw failFetch;
  return served;
});
const serverSupportsRulesets = vi.fn(async () => supported);

vi.mock("../api/client", () => ({
  fetchOwnRulesets: () => fetchOwnRulesets(),
  serverSupportsRulesets: () => serverSupportsRulesets(),
}));
vi.mock("../storage/db", () => ({
  getDevice: vi.fn(async () => device),
  getRulesetsRecord: vi.fn(async () => (record ? structuredClone(record) : undefined)),
  putRulesetsRecord: vi.fn(async (r: RulesetsRecord) => {
    record = structuredClone(r);
  }),
}));

const { refreshRulesets, onRulesChanged, failedRulesetCount } = await import("./fetch");
const { getEffectiveRules, getLoadedRulesets, invalidateRulesetsMemory, decryptRuleset } = await import("./index");
const { isUrlBlocked } = await import("./effective");

const accountKey = toB64(generateAccountKey());
const SDEK_KEY_VERSION = 1;

async function seal(id: string, revision: number, plaintext: RulesetPlaintext, key = accountKey): Promise<unknown> {
  const sdek = await getSdek(key, SDEK_KEY_VERSION);
  return encryptWithSdek(plaintext, sdek, SDEK_KEY_VERSION, buildRulesetAad(id, revision));
}

const ws = (name: string, rules: RulesetPlaintext["rules"]): RulesetPlaintext => ({ v: 1, name, rules });

beforeEach(() => {
  device = {
    id: "self",
    serverUrl: "https://example.test",
    deviceId: "d1",
    userId: "u1",
    email: "a@example.test",
    accessToken: "t",
    accessTokenExpiresAt: "",
    refreshToken: "r",
    accountKey,
    accountKeyVersion: 1,
  };
  record = undefined;
  supported = true;
  served = [];
  failFetch = null;
  fetchOwnRulesets.mockClear();
  serverSupportsRulesets.mockClear();
  invalidateRulesetsMemory();
});

describe("decryptRuleset", () => {
  it("round-trips and binds the id and the revision", async () => {
    const env = await seal("r1", 3, ws("Work", [{ id: "a", kind: "blockLocal" }]));
    await expect(decryptRuleset(accountKey, "r1", 3, env)).resolves.toMatchObject({ name: "Work" });
    await expect(decryptRuleset(accountKey, "r2", 3, env)).rejects.toThrow(); // swapped to another id
    await expect(decryptRuleset(accountKey, "r1", 2, env)).rejects.toThrow(); // older revision served as current
    await expect(decryptRuleset(accountKey, "r1", 4, env)).rejects.toThrow();
    await expect(decryptRuleset(toB64(generateAccountKey()), "r1", 3, env)).rejects.toThrow();
  });

  it("is not an operation envelope", async () => {
    const sdek = await getSdek(accountKey, 1);
    const asOperation = encryptWithSdek(ws("x", []), sdek, 1, buildOperationAad("syncRuleset", "r1", "3"));
    await expect(decryptRuleset(accountKey, "r1", 3, asOperation)).rejects.toThrow();
  });

  it("matches the dashboard's AAD byte for byte", () => {
    expect(new TextDecoder().decode(buildRulesetAad("0198f1d1-5e12-7a11-9d0a-2f2d1f6a7c30", 3))).toBe(
      '["syncRuleset","0198f1d1-5e12-7a11-9d0a-2f2d1f6a7c30",3]',
    );
  });

  it("reads what the dashboard wrote (vector produced by web's encryptRuleset)", async () => {
    expect(fromB64(vector.akB64)).toHaveLength(32);
    await expect(decryptRuleset(vector.akB64, vector.rulesetId, vector.revision, vector.envelope)).resolves.toEqual(
      vector.plaintext,
    );
    // and nothing else: another revision or id fails
    await expect(decryptRuleset(vector.akB64, vector.rulesetId, vector.revision - 1, vector.envelope)).rejects.toThrow();
    await expect(decryptRuleset(vector.akB64, "other-id", vector.revision, vector.envelope)).rejects.toThrow();
  });
});

describe("refreshRulesets", () => {
  it("fetches, verifies and stores rulesets, and enforces their union", async () => {
    served = [
      { id: "def", revision: 1, isDefault: true, envelope: null },
      { id: "w", revision: 2, isDefault: false, envelope: await seal("w", 2, ws("Work", [{ id: "1", kind: "blockLocal" }])) },
      { id: "s", revision: 1, isDefault: false, envelope: await seal("s", 1, ws("Social", [{ id: "2", kind: "blockDomain", domain: "facebook.com" }])) },
    ];
    expect(await refreshRulesets(true)).toBe("updated");
    expect(record?.rulesets.map((r) => `${r.id}@${r.revision}`)).toEqual(["def@1", "w@2", "s@1"]);

    const rules = await getEffectiveRules();
    expect(isUrlBlocked("http://localhost/", rules)).toBe(true);
    expect(isUrlBlocked("https://facebook.com/", rules)).toBe(true);
    expect(isUrlBlocked("https://example.com/", rules)).toBe(false);
    const { effective } = await getLoadedRulesets();
    expect(effective.rulesets.map((r) => r.name)).toEqual(["", "Work", "Social"]);
    // Nothing readable sits on disk: the stored form is the envelope.
    expect(JSON.stringify(record)).not.toContain("facebook");
  });

  it("an untouched Default is no rules", async () => {
    served = [{ id: "def", revision: 1, isDefault: true, envelope: null }];
    await refreshRulesets(true);
    expect((await getEffectiveRules()).hash).toBe("");
  });

  it("a device in no ruleset has no rules", async () => {
    served = [];
    await refreshRulesets(true);
    expect((await getEffectiveRules()).hash).toBe("");
    expect(record?.rulesets).toEqual([]);
  });

  it("is unchanged when the (id, revision) list is the same, and announces nothing", async () => {
    served = [{ id: "w", revision: 1, isDefault: false, envelope: await seal("w", 1, ws("W", [{ id: "1", kind: "blockLocal" }])) }];
    const listener = vi.fn();
    const off = onRulesChanged(listener);
    await refreshRulesets(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(await refreshRulesets(true)).toBe("unchanged");
    expect(listener).toHaveBeenCalledTimes(1);
    off();
  });

  it("announces a change when a revision changes the rules, and not when it changes only a name", async () => {
    const listener = vi.fn();
    const off = onRulesChanged(listener);
    served = [{ id: "w", revision: 1, isDefault: false, envelope: await seal("w", 1, ws("W", [{ id: "1", kind: "blockLocal" }])) }];
    await refreshRulesets(true);
    served = [{ id: "w", revision: 2, isDefault: false, envelope: await seal("w", 2, ws("Renamed", [{ id: "1", kind: "blockLocal" }])) }];
    await refreshRulesets(true);
    expect(listener).toHaveBeenCalledTimes(1);
    served = [{ id: "w", revision: 3, isDefault: false, envelope: await seal("w", 3, ws("Renamed", [{ id: "9", kind: "blockDomain", domain: "a.com" }])) }];
    await refreshRulesets(true);
    expect(listener).toHaveBeenCalledTimes(2);
    off();
  });

  it("rejects a ruleset whose AAD doesn't match and keeps the last known version", async () => {
    served = [{ id: "w", revision: 1, isDefault: false, envelope: await seal("w", 1, ws("W", [{ id: "1", kind: "blockLocal" }])) }];
    await refreshRulesets(true);
    expect(isUrlBlocked("http://localhost/", await getEffectiveRules())).toBe(true);

    // The server presents revision 2 but the envelope was made for revision 1 (a replay),
    // and a swapped one: another ruleset's ciphertext under this id.
    served = [{ id: "w", revision: 2, isDefault: false, envelope: await seal("w", 1, ws("Old", [])) }];
    await refreshRulesets(true);
    expect(failedRulesetCount()).toBe(1);
    expect(record?.rulesets).toEqual([expect.objectContaining({ id: "w", revision: 1 })]);
    expect(isUrlBlocked("http://localhost/", await getEffectiveRules())).toBe(true);

    served = [{ id: "w", revision: 3, isDefault: false, envelope: await seal("other", 3, ws("Swapped", [])) }];
    await refreshRulesets(true);
    expect(record?.rulesets).toEqual([expect.objectContaining({ id: "w", revision: 1 })]);
  });

  it("refuses a lower revision than the one held (a replay of an older, valid envelope)", async () => {
    served = [{ id: "w", revision: 2, isDefault: false, envelope: await seal("w", 2, ws("W", [{ id: "1", kind: "blockLocal" }])) }];
    await refreshRulesets(true);
    // The server replays revision 1, which was a valid ruleset with no rules.
    served = [{ id: "w", revision: 1, isDefault: false, envelope: await seal("w", 1, ws("W", [])) }];
    await refreshRulesets(true);
    expect(record?.rulesets).toEqual([expect.objectContaining({ id: "w", revision: 2 })]);
    expect(failedRulesetCount()).toBe(1);
    expect(isUrlBlocked("http://localhost/", await getEffectiveRules())).toBe(true);
  });

  it("a ruleset that never decrypted applies nothing", async () => {
    served = [{ id: "w", revision: 1, isDefault: false, envelope: await seal("w", 1, ws("W", [{ id: "1", kind: "blockLocal" }]), toB64(generateAccountKey())) }];
    await refreshRulesets(true);
    expect(record?.rulesets).toEqual([]);
    expect(failedRulesetCount()).toBe(1);
    expect((await getEffectiveRules()).hash).toBe("");
  });

  it("only a Default may lack an envelope", async () => {
    served = [{ id: "w", revision: 1, isDefault: false, envelope: null }];
    await refreshRulesets(true);
    expect(record?.rulesets).toEqual([]);
  });

  it("offline or a server error throws and keeps what was known", async () => {
    served = [{ id: "w", revision: 1, isDefault: false, envelope: await seal("w", 1, ws("W", [{ id: "1", kind: "blockLocal" }])) }];
    await refreshRulesets(true);
    failFetch = new TypeError("offline");
    await expect(refreshRulesets(true)).rejects.toThrow("offline");
    expect(isUrlBlocked("http://localhost/", await getEffectiveRules())).toBe(true);
    failFetch = null;
    serverSupportsRulesets.mockRejectedValueOnce(new TypeError("offline"));
    await expect(refreshRulesets(true)).rejects.toThrow("offline");
    expect(isUrlBlocked("http://localhost/", await getEffectiveRules())).toBe(true);
  });

  it("a server without rulesets means none, and drops what was stored", async () => {
    served = [{ id: "w", revision: 1, isDefault: false, envelope: await seal("w", 1, ws("W", [{ id: "1", kind: "blockLocal" }])) }];
    await refreshRulesets(true);
    supported = false;
    expect(await refreshRulesets(true)).toBe("unsupported");
    expect((await getEffectiveRules()).hash).toBe("");
    expect(fetchOwnRulesets).toHaveBeenCalledTimes(1);
  });

  it("periodic checks are throttled, and a push forces one", async () => {
    served = [];
    await refreshRulesets(true);
    fetchOwnRulesets.mockClear();
    expect(await refreshRulesets()).toBe("unchanged");
    expect(fetchOwnRulesets).not.toHaveBeenCalled();
    await refreshRulesets(true);
    expect(fetchOwnRulesets).toHaveBeenCalledTimes(1);
  });

  it("does nothing without a device", async () => {
    device = undefined;
    expect(await refreshRulesets(true)).toBe("no-device");
  });

  it("keeps the bookmark catch-up bookmark across fetches", async () => {
    served = [];
    await refreshRulesets(true);
    record = { ...record!, appliedFolderRules: { excluded: ["a"], included: [] } };
    served = [{ id: "w", revision: 1, isDefault: false, envelope: await seal("w", 1, ws("W", [{ id: "1", kind: "blockLocal" }])) }];
    await refreshRulesets(true);
    expect(record?.appliedFolderRules).toEqual({ excluded: ["a"], included: [] });
  });
});
