import { afterEach, describe, expect, it } from "vitest";
import { setLanguage } from "./index";
import { timeAgo } from "./format";
import { recoveryKitText } from "../util/recovery-kit";

afterEach(async () => {
  await setLanguage("en");
});

describe("timeAgo", () => {
  const now = Date.parse("2026-11-05T12:00:00Z");
  it("formats in the active language", async () => {
    await setLanguage("en");
    expect(timeAgo("2026-11-05T11:55:00Z", now)).toBe("5 minutes ago");
    await setLanguage("de");
    expect(timeAgo("2026-11-05T11:55:00Z", now)).toBe("vor 5 Minuten");
  });
  it("says never without a date", async () => {
    expect(timeAgo(null, now)).toBe("never");
    await setLanguage("es");
    expect(timeAgo(null, now)).toBe("nunca");
  });
});

describe("recovery kit language", () => {
  it("is worded in the interface language", async () => {
    await setLanguage("de");
    const text = recoveryKitText({
      email: "a@example.com",
      serverUrl: "https://sync.example.com",
      code: "AAAA-BBBB",
      generatedAt: new Date("2026-11-05T10:00:00Z"),
    });
    expect(text).toContain("Wiederherstellungsset");
    expect(text).toContain("Passwort vergessen?");
    expect(text).toContain("AAAA-BBBB");
  });
});
