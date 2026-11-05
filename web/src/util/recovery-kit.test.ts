import { describe, expect, it } from "vitest";
import { recoveryKitText } from "./recovery-kit";

describe("recoveryKitText", () => {
  it("lists the account, server, code, date, steps and the once-only warning", () => {
    const text = recoveryKitText({
      email: "a@example.com",
      serverUrl: "https://sync.example.com",
      code: "AAAA-BBBB",
      generatedAt: new Date("2026-11-05T10:00:00Z"),
    });
    expect(text).toContain("Account: a@example.com");
    expect(text).toContain("Server: https://sync.example.com");
    expect(text).toContain("Recovery code: AAAA-BBBB");
    expect(text).toContain("Generated: 2026-11-05");
    expect(text).toContain("Forgot your password?");
    expect(text).toContain("Each code works once");
  });
});
