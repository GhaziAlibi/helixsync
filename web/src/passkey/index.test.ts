import { describe, expect, it } from "vitest";
import { parseRescueFile, type PasskeyRecord } from "./index";

const record: PasskeyRecord = {
  v: 1,
  email: "a@example.com",
  serverUrl: "https://sync.example.com",
  credentialId: "cred",
  prfSalt: "salt",
  sealed: "{}",
  createdAt: "2026-11-05T10:00:00.000Z",
};

describe("parseRescueFile", () => {
  it("accepts a well-formed rescue file", () => {
    expect(parseRescueFile(JSON.stringify(record))).toEqual(record);
  });

  it("rejects non-JSON, other JSON and files missing a field", () => {
    expect(() => parseRescueFile("nope")).toThrow(/rescue file/);
    expect(() => parseRescueFile("[]")).toThrow(/rescue file/);
    expect(() => parseRescueFile(JSON.stringify({ ...record, v: 2 }))).toThrow(/rescue file/);
    expect(() => parseRescueFile(JSON.stringify({ ...record, sealed: "" }))).toThrow(/rescue file/);
  });
});
