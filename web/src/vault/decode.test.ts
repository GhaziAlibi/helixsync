import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import {
  UnsupportedEnvelopeVersionError,
  buildOperationAad,
  fromB64,
  getSdek,
  toB64,
  type EncryptionEnvelope,
} from "../crypto";
import { decodeSnapshot } from "./decode";
import vectors from "./fixtures/extension-vectors.json";
import type { SnapshotObjectWire, SnapshotWire } from "./types";

const accountKey = fromB64(vectors.akB64);

/** Test-only encryption (the web bundle has none), for shapes the extension
 * fixtures don't cover. */
async function encrypt(
  plaintext: unknown,
  objectType: string,
  objectId: string,
  operationType: string,
): Promise<EncryptionEnvelope> {
  const sdek = await getSdek(accountKey, 1);
  const nonce = randomBytes(24);
  const ciphertext = xchacha20poly1305(sdek, nonce, buildOperationAad(objectType, objectId, operationType)).encrypt(
    new TextEncoder().encode(JSON.stringify(plaintext)),
  );
  return { v: 2, keyVersion: 1, alg: "xchacha20poly1305", nonce: toB64(nonce), ciphertext: toB64(ciphertext) };
}

async function object(
  objectType: string,
  objectId: string,
  operationType: string,
  plaintext: unknown,
  deviceId = "device-a",
): Promise<SnapshotObjectWire> {
  return {
    objectType,
    objectId,
    operationType,
    encryptionVersion: 1,
    payload: await encrypt(plaintext, objectType, objectId, operationType),
    deviceId,
  };
}

function snapshot(objects: SnapshotObjectWire[]): SnapshotWire {
  return { snapshotCursor: 1, objects, tombstones: [] };
}

const bulk = (v: { objectId: string; container: unknown }, id = v.objectId): SnapshotObjectWire => ({
  objectType: "historyVisit",
  objectId: id,
  operationType: "bulkImport",
  encryptionVersion: 1,
  payload: v.container,
});

describe("decodeSnapshot with the extension's records", () => {
  it("decodes a bookmark", async () => {
    const b = vectors.bookmark;
    const data = await decodeSnapshot(
      snapshot([
        {
          objectType: b.objectType,
          objectId: b.objectId,
          operationType: b.operationType,
          encryptionVersion: 1,
          payload: b.envelope,
        },
      ]),
      accountKey,
    );
    expect(data.bookmarks).toEqual([
      { id: b.objectId, title: "Example", url: "https://example.com/", parent: null, position: "a0" },
    ]);
    expect(data.unreadable).toBe(0);
  });

  it("decodes a single history visit", async () => {
    const v = vectors.visit;
    const data = await decodeSnapshot(
      snapshot([
        {
          objectType: "historyVisit",
          objectId: v.objectId,
          operationType: "visit",
          encryptionVersion: 1,
          payload: v.envelope,
        },
      ]),
      accountKey,
    );
    expect(data.history).toEqual([{ url: "https://v.test/", title: "V", t: Date.parse("2023-11-15T00:00:00.000Z") }]);
  });

  const v2Expected = [
    { url: "https://b.test/", title: "", t: 1700000120000 },
    { url: "https://a.test/", title: "A", t: 1700000060000 },
    { url: "https://a.test/", title: "A", t: 1700000000000 },
  ];

  it("decodes a bulk v2 container with deflate-raw", async () => {
    const data = await decodeSnapshot(snapshot([bulk(vectors.bulkV2Deflate)]), accountKey);
    expect(data.history).toEqual(v2Expected);
    expect(data.unreadable).toBe(0);
  });

  it("decodes a bulk v2 container without a codec", async () => {
    const data = await decodeSnapshot(snapshot([bulk(vectors.bulkV2Plain)]), accountKey);
    expect(data.history).toEqual(v2Expected);
  });

  it("decodes a bulk v1 container", async () => {
    const data = await decodeSnapshot(snapshot([bulk(vectors.bulkV1)]), accountKey);
    expect(data.history).toEqual([
      { url: "https://c.test/", title: "C", t: Date.parse("2023-11-14T22:13:20.000Z") },
    ]);
  });

  it("skips a segment authenticated for another object", async () => {
    const data = await decodeSnapshot(
      snapshot([bulk(vectors.bulkV2Deflate, "0198f1d1-5e12-7a11-9d0a-ffffffffffff")]),
      accountKey,
    );
    expect(data.history).toEqual([]);
    expect(data.unreadable).toBe(1);
  });

  it("keeps the readable segments when one of a container's segments is bad", async () => {
    const good = vectors.bulkV2Plain.container.segments[0];
    const data = await decodeSnapshot(
      snapshot([
        bulk({
          objectId: vectors.bulkV2Plain.objectId,
          container: { ...vectors.bulkV2Plain.container, segments: [{ ciphertext: "x" }, good, "junk"] },
        }),
      ]),
      accountKey,
    );
    expect(data.history).toHaveLength(3);
    expect(data.unreadable).toBe(2);
  });

  it("shows a visit that arrives both live and inside a bulk import once", async () => {
    const t = 1700000000000;
    const live = await object("historyVisit", "visit-1", "visit", {
      url: "https://a.test/",
      visitedAt: new Date(t).toISOString(),
    });
    const data = await decodeSnapshot(snapshot([live, bulk(vectors.bulkV2Deflate)]), accountKey);
    expect(data.history.filter((v) => v.url === "https://a.test/" && v.t === t)).toHaveLength(1);
    expect(data.history).toHaveLength(3);
  });
});

describe("decodeSnapshot failures", () => {
  it("throws the distinct error for an envelope from another format", async () => {
    const future = { ...vectors.bookmark.envelope, v: 3 };
    await expect(
      decodeSnapshot(
        snapshot([
          {
            objectType: "bookmark",
            objectId: vectors.bookmark.objectId,
            operationType: "create",
            encryptionVersion: 1,
            payload: future,
          },
        ]),
        accountKey,
      ),
    ).rejects.toBeInstanceOf(UnsupportedEnvelopeVersionError);
  });

  it("finds an unsupported segment inside a bulk container", async () => {
    const container = {
      ...vectors.bulkV2Plain.container,
      segments: [vectors.bulkV2Plain.container.segments[0], { ...vectors.bulkV2Plain.container.segments[0], v: 1 }],
    };
    await expect(
      decodeSnapshot(snapshot([bulk({ objectId: vectors.bulkV2Plain.objectId, container })]), accountKey),
    ).rejects.toBeInstanceOf(UnsupportedEnvelopeVersionError);
  });

  it("skips a record under the wrong account key, and counts it", async () => {
    const other = new Uint8Array(32).fill(1);
    const data = await decodeSnapshot(
      snapshot([
        {
          objectType: "bookmark",
          objectId: vectors.bookmark.objectId,
          operationType: "create",
          encryptionVersion: 1,
          payload: vectors.bookmark.envelope,
        },
      ]),
      other,
    );
    expect(data.bookmarks).toEqual([]);
    expect(data.unreadable).toBe(1);
  });

  it("skips a record relabelled to another operation type", async () => {
    const data = await decodeSnapshot(
      snapshot([
        {
          objectType: "bookmark",
          objectId: vectors.bookmark.objectId,
          operationType: "update", // was encrypted as "create"
          encryptionVersion: 1,
          payload: vectors.bookmark.envelope,
        },
      ]),
      accountKey,
    );
    expect(data.bookmarks).toEqual([]);
    expect(data.unreadable).toBe(1);
  });

  it("never reads an unencrypted object as plaintext", async () => {
    const data = await decodeSnapshot(
      snapshot([
        {
          objectType: "bookmark",
          objectId: "b1",
          operationType: "create",
          encryptionVersion: 0,
          payload: { title: "Leaked", url: "https://leak.test/", parent: null, position: "a" },
        },
      ]),
      accountKey,
    );
    expect(data.bookmarks).toEqual([]);
    expect(data.unreadable).toBe(1);
  });

  it("ignores object types the vault doesn't show", async () => {
    const data = await decodeSnapshot(
      snapshot([await object("extensionMeta", "m1", "set", { anything: true })]),
      accountKey,
    );
    expect(data).toMatchObject({ bookmarks: [], history: [], tabs: [], unreadable: 0, incomplete: 0 });
  });
});

describe("decodeSnapshot object types", () => {
  it("decodes folders, bookmarks, windows, tab groups and tabs", async () => {
    const data = await decodeSnapshot(
      snapshot([
        await object("bookmarkFolder", "f1", "create", { title: "Work", url: null, parent: null, position: "a0" }),
        await object("bookmark", "b1", "create", { title: "Docs", url: "https://docs.test/", parent: "f1", position: "a1" }),
        await object("window", "w1", "create", { focused: true, incognito: false }, "device-b"),
        await object("tabGroup", "g1", "create", { title: "Read", color: "blue", collapsed: false }, "device-b"),
        await object(
          "tab",
          "t1",
          "create",
          { url: "https://t.test/", title: "T", pinned: true, index: 2, windowObjectId: "w1", active: true, groupObjectId: "g1" },
          "device-b",
        ),
      ]),
      accountKey,
    );
    expect(data.folders).toEqual([{ id: "f1", title: "Work", parent: null, position: "a0" }]);
    expect(data.bookmarks[0]).toMatchObject({ id: "b1", parent: "f1" });
    expect(data.windows).toEqual([{ id: "w1", deviceId: "device-b", focused: true, incognito: false }]);
    expect(data.tabGroups).toEqual([{ id: "g1", deviceId: "device-b", title: "Read", color: "blue", collapsed: false }]);
    expect(data.tabs).toEqual([
      {
        id: "t1",
        deviceId: "device-b",
        windowId: "w1",
        groupId: "g1",
        url: "https://t.test/",
        title: "T",
        pinned: true,
        index: 2,
        active: true,
      },
    ]);
  });

  it("rebuilds a bookmark from its layers: later operations override only the fields they carry", async () => {
    const withLayers: SnapshotObjectWire = {
      ...(await object("bookmark", "b1", "move", { parent: "f2", position: "a9" })),
      layers: [
        {
          operationType: "create",
          payload: (await object("bookmark", "b1", "create", { title: "Old", url: "https://a.test/", parent: null, position: "a0" })).payload,
        },
        {
          operationType: "update",
          payload: (await object("bookmark", "b1", "update", { title: "New title" })).payload,
        },
      ],
    };
    const data = await decodeSnapshot(snapshot([withLayers]), accountKey);
    expect(data.bookmarks).toEqual([
      { id: "b1", title: "New title", url: "https://a.test/", parent: "f2", position: "a9" },
    ]);
    expect(data.incomplete).toBe(0);
    expect(data.unreadable).toBe(0);
  });

  it("rebuilds a tab whose latest operation was only an activation", async () => {
    const tab: SnapshotObjectWire = {
      ...(await object("tab", "t1", "activate", { active: true })),
      layers: [
        {
          operationType: "create",
          payload: (
            await object("tab", "t1", "create", { url: "https://t.test/", title: "T", pinned: false, index: 3, windowObjectId: "w1", active: false })
          ).payload,
        },
      ],
    };
    const data = await decodeSnapshot(snapshot([tab]), accountKey);
    expect(data.tabs).toMatchObject([{ id: "t1", url: "https://t.test/", index: 3, active: true, windowId: "w1" }]);
    expect(data.incomplete).toBe(0);
  });

  it("keeps what it can read when a layer fails authentication, and says so", async () => {
    const broken: SnapshotObjectWire = {
      ...(await object("bookmark", "b1", "create", { title: "T", url: "https://a.test/", parent: null, position: "a0" })),
      layers: [{ operationType: "update", payload: (await object("bookmark", "other", "update", { title: "X" })).payload }],
    };
    const data = await decodeSnapshot(snapshot([broken]), accountKey);
    expect(data.bookmarks).toHaveLength(1);
    expect(data.unreadable).toBe(1);
  });

  it("stops on a layer in a format it can't read", async () => {
    const future: SnapshotObjectWire = {
      ...(await object("bookmark", "b1", "create", { title: "T", url: "https://a.test/", parent: null, position: "a0" })),
      layers: [{ operationType: "update", payload: { ...vectors.bookmark.envelope, v: 3 } }],
    };
    await expect(decodeSnapshot(snapshot([future]), accountKey)).rejects.toBeInstanceOf(UnsupportedEnvelopeVersionError);
  });

  it("counts an object whose latest operation was only a partial update as incomplete", async () => {
    const data = await decodeSnapshot(
      snapshot([
        await object("bookmark", "b1", "move", { parent: "f1", position: "a2" }),
        await object("tab", "t1", "activate", { active: true }),
        await object("bookmarkFolder", "f2", "move", { parent: null, position: "a3" }),
      ]),
      accountKey,
    );
    expect(data.bookmarks).toEqual([]);
    expect(data.tabs).toEqual([]);
    expect(data.folders).toEqual([]);
    expect(data.incomplete).toBe(3);
    expect(data.unreadable).toBe(0);
  });

  it("sorts history newest first", async () => {
    const data = await decodeSnapshot(
      snapshot([
        await object("historyVisit", "v1", "visit", { url: "https://1.test/", visitedAt: "2024-01-01T00:00:00Z" }),
        await object("historyVisit", "v2", "visit", { url: "https://2.test/", visitedAt: "2024-03-01T00:00:00Z" }),
        await object("historyVisit", "v3", "visit", { url: "https://3.test/", visitedAt: "2024-02-01T00:00:00Z" }),
      ]),
      accountKey,
    );
    expect(data.history.map((v) => v.url)).toEqual(["https://2.test/", "https://3.test/", "https://1.test/"]);
  });
});
