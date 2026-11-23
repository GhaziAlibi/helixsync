import { describe, expect, it, vi } from "vitest";

// The nonce the vector was generated with (bytes 1..24), so the ciphertext is
// reproducible and can be compared with what the extension decrypts.
vi.mock("@noble/hashes/utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@noble/hashes/utils.js")>();
  const nonce = Uint8Array.from({ length: 24 }, (_, i) => i + 1);
  return { ...actual, randomBytes: (n?: number) => (n === 24 ? nonce : actual.randomBytes(n)) };
});

import { fromB64 } from "../crypto";
import { encryptRuleset } from "./codec";
import vector from "./fixtures/ruleset-vector.json";
import type { RulesetPlaintext } from "./types";

describe("ruleset vector shared with the extension", () => {
  it("is exactly what the dashboard's encryptor produces", async () => {
    const envelope = await encryptRuleset(
      fromB64(vector.akB64),
      1,
      vector.rulesetId,
      vector.revision,
      vector.plaintext as RulesetPlaintext,
    );
    expect(envelope).toEqual(vector.envelope);
  });
});
