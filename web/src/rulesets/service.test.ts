import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fromB64 } from "../crypto";
import vectors from "../vault/fixtures/extension-vectors.json";

const accountKey = fromB64(vectors.akB64);
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubEnv("VITE_API_BASE_URL", "");
  vi.resetModules();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function load() {
  return {
    service: await import("./service"),
    codec: await import("./codec"),
    client: await import("../api/client"),
  };
}

describe("decryptRulesets", () => {
  it("reads an untouched Default as no rules and marks a broken envelope unreadable", async () => {
    const { service, codec } = await load();
    const good = await codec.encryptRuleset(accountKey, 1, "id-work", 2, {
      v: 1,
      name: "Work",
      rules: [{ id: "a", kind: "blockLocal" }],
    });
    const wrongRevision = await codec.encryptRuleset(accountKey, 1, "id-bad", 5, { v: 1, name: "Bad", rules: [] });
    const out = await service.decryptRulesets(accountKey, [
      { id: "id-def", revision: 1, isDefault: true, envelope: null, deviceIds: ["d1"], createdAt: "", updatedAt: "" },
      { id: "id-work", revision: 2, isDefault: false, envelope: good, deviceIds: [], createdAt: "", updatedAt: "" },
      { id: "id-bad", revision: 4, isDefault: false, envelope: wrongRevision, deviceIds: [], createdAt: "", updatedAt: "" },
    ]);
    expect(out[0].plaintext).toEqual({ v: 1, name: "Default", rules: [] });
    expect(out[1].plaintext?.name).toBe("Work");
    expect(out[2].plaintext).toBeNull();
  });
});

describe("saving", () => {
  it("creates revision 1 under a client-chosen id, encrypted for that id", async () => {
    const { service, codec } = await load();
    fetchMock
      .mockResolvedValueOnce(json({ id: "u", email: "e", accountKeyVersion: 1, wrappedAk: "", kdfSalt: "", kdfParams: {} }))
      .mockResolvedValueOnce(json({}, 201));
    await service.createRuleset(accountKey, { v: 1, name: "Social", rules: [{ id: "a", kind: "blockDomain", domain: "facebook.com" }] });

    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe("/api/v1/rulesets");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(body)).not.toContain("facebook");
    const plain = await codec.decryptRuleset(accountKey, body.id, 1, body.envelope);
    expect(plain.name).toBe("Social");
  });

  it("updates as current revision + 1 with If-Match of the current one", async () => {
    const { service, codec } = await load();
    fetchMock
      .mockResolvedValueOnce(json({ accountKeyVersion: 1 }))
      .mockResolvedValueOnce(json({}));
    await service.saveRuleset(accountKey, { id: "rid", revision: 4 }, { v: 1, name: "Work", rules: [] });

    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe("/api/v1/rulesets/rid");
    expect(init.method).toBe("PUT");
    expect(init.headers["If-Match"]).toBe("4");
    const { envelope } = JSON.parse(init.body);
    await expect(codec.decryptRuleset(accountKey, "rid", 5, envelope)).resolves.toMatchObject({ name: "Work" });
    await expect(codec.decryptRuleset(accountKey, "rid", 4, envelope)).rejects.toThrow();
  });

  it("surfaces a revision conflict from the server", async () => {
    const { service } = await load();
    fetchMock
      .mockResolvedValueOnce(json({ accountKeyVersion: 1 }))
      .mockResolvedValueOnce(json({ error: "revision_conflict", message: "conflict" }, 409));
    await expect(service.saveRuleset(accountKey, { id: "rid", revision: 1 }, { v: 1, name: "x", rules: [] })).rejects.toMatchObject({
      status: 409,
      code: "revision_conflict",
    });
  });

  it("assignment sends exactly the chosen ids with the CSRF token", async () => {
    const { client } = await load();
    client.setCsrfToken("tok");
    fetchMock.mockResolvedValueOnce(json({ deviceIds: ["a", "b"] }));
    await expect(client.setRulesetDevices("rid", ["a", "b"])).resolves.toEqual(["a", "b"]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/v1/rulesets/rid/devices");
    expect(init.method).toBe("PUT");
    expect(init.headers["X-CSRF-Token"]).toBe("tok");
    expect(JSON.parse(init.body)).toEqual({ deviceIds: ["a", "b"] });
  });
});

describe("per-device test of a URL", () => {
  const rs = (id: string, name: string, deviceIds: string[], rules: import("./types").Rule[], isDefault = false) => ({
    id,
    revision: 1,
    isDefault,
    deviceIds,
    plaintext: { v: 1 as const, name, rules },
  });
  const rulesets = [
    rs("def", "Default", ["d1", "d2"], [], true),
    rs("work", "Work", ["d1"], [
      { id: "1", kind: "excludeFolder", folderId: "f" },
      { id: "2", kind: "blockLocal" },
    ]),
    rs("social", "Social", ["d1", "d3"], [{ id: "3", kind: "blockDomain", domain: "facebook.com" }]),
  ];

  it("names the ruleset and rule that block the address for that device", async () => {
    const { service } = await load();
    expect(service.findBlockingRule("localhost:3000/app", "d1", rulesets)).toMatchObject({
      ruleset: { id: "work" },
      rule: { id: "2" },
    });
    expect(service.findBlockingRule("www.facebook.com/x", "d1", rulesets)).toMatchObject({ ruleset: { id: "social" } });
    expect(service.findBlockingRule("https://www.facebook.com/", "d3", rulesets)).toMatchObject({ ruleset: { id: "social" } });
  });

  it("does not count rulesets the device isn't in", async () => {
    const { service } = await load();
    expect(service.findBlockingRule("facebook.com", "d2", rulesets)).toBeNull();
    expect(service.findBlockingRule("localhost", "d3", rulesets)).toBeNull();
    expect(service.findBlockingRule("facebook.com", "unknown-device", rulesets)).toBeNull();
  });

  it("never reports a folder rule as blocking an address", async () => {
    const { service } = await load();
    expect(service.findBlockingRule("https://example.com/", "d1", rulesets)).toBeNull();
  });

  it("puts https:// in front of an address typed without a scheme", async () => {
    const { service } = await load();
    expect(service.toTestUrl("example.com/a")).toBe("https://example.com/a");
    expect(service.toTestUrl("localhost:3000")).toBe("https://localhost:3000");
    expect(service.toTestUrl(" http://a.b ")).toBe("http://a.b");
    expect(service.toTestUrl("chrome://settings")).toBe("chrome://settings");
  });
});

describe("old extensions", () => {
  it("flags versions below the first one with rulesets, and unknown ones", async () => {
    const { service } = await load();
    const min = service.MIN_RULESET_EXTENSION_VERSION;
    expect(service.ignoresRulesets("1.1.1")).toBe(true);
    expect(service.ignoresRulesets(null)).toBe(true);
    expect(service.ignoresRulesets(min)).toBe(false);
    expect(service.ignoresRulesets("1.10.0")).toBe(false);
    expect(service.ignoresRulesets("2.0.0")).toBe(false);
    expect(service.compareVersions("1.2.0-beta", "1.2.0")).toBe(0);
  });
});
