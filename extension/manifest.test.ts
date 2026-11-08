import { describe, expect, it } from "vitest";
import manifest from "./manifest.json";
import { FIREFOX_MIN_VERSION, firefoxManifest } from "./src/firefox-manifest";

// [SEC-16] regression: with no "incognito" key, Chrome defaults to spanning
// mode and the extension receives incognito tab/window events once the user
// enables "Allow in Incognito". Declaring "not_allowed" removes that option
// entirely, so no capture-side filter is needed.
describe("[SEC-16] manifest blocks incognito", () => {
  it("declares incognito: not_allowed", () => {
    expect(manifest.incognito).toBe("not_allowed");
  });
});

describe("Firefox manifest", () => {
  const firefox = firefoxManifest(manifest);

  it("is MV2 with a persistent module background page", () => {
    expect(firefox.manifest_version).toBe(2);
    expect(firefox.background).toEqual({ scripts: ["background.js"], type: "module", persistent: true });
    expect(firefox.minimum_chrome_version).toBeUndefined();
    expect(firefox.browser_specific_settings).toEqual({ gecko: { strict_min_version: FIREFOX_MIN_VERSION } });
  });

  it("keeps [SEC-16] incognito: not_allowed", () => {
    expect(firefox.incognito).toBe("not_allowed");
  });

  it("converts MV3-only keys to their MV2 form", () => {
    expect(firefox.action).toBeUndefined();
    expect(firefox.browser_action).toEqual(manifest.action);
    expect(firefox.optional_host_permissions).toBeUndefined();
    expect(firefox.optional_permissions).toEqual([...manifest.optional_permissions, ...manifest.optional_host_permissions]);
    expect(firefox.content_security_policy).toBe(manifest.content_security_policy.extension_pages);
    expect(firefox.version).toBe(manifest.version);
    expect(firefox.permissions).toEqual(manifest.permissions);
  });
});
