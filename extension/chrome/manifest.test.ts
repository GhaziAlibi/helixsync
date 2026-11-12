import { describe, expect, it } from "vitest";
import manifest from "./manifest.json";

// [SEC-16] regression: with no "incognito" key, Chrome defaults to spanning
// mode and the extension receives incognito tab/window events once the user
// enables "Allow in Incognito". Declaring "not_allowed" removes that option
// entirely, so no capture-side filter is needed.
describe("[SEC-16] manifest blocks incognito", () => {
  it("declares incognito: not_allowed", () => {
    expect(manifest.incognito).toBe("not_allowed");
  });
});
