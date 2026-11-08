import { describe, expect, it } from "vitest";
import chrome from "../chrome/manifest.json";
import firefox from "./manifest.json";

describe("Firefox manifest", () => {
  it("is MV2 with a persistent module background page", () => {
    expect(firefox.manifest_version).toBe(2);
    expect(firefox.background).toEqual({ scripts: ["background.js"], type: "module", persistent: true });
    expect(firefox.browser_specific_settings.gecko.strict_min_version).toBe("159.0");
    expect(firefox).not.toHaveProperty("minimum_chrome_version");
  });

  it("keeps [SEC-16] incognito: not_allowed", () => {
    expect(firefox.incognito).toBe("not_allowed");
  });

  // The two manifests are separate files; these keep them describing the same
  // extension.
  it("matches the Chrome manifest on everything both browsers share", () => {
    for (const key of ["name", "default_locale", "version", "description", "icons", "permissions"] as const) {
      expect(firefox[key], key).toEqual(chrome[key]);
    }
    expect(firefox.browser_action).toEqual(chrome.action);
    // MV2 has no optional_host_permissions: host patterns go with the
    // optional API permissions.
    expect(firefox.optional_permissions).toEqual([...chrome.optional_permissions, ...chrome.optional_host_permissions]);
    expect(firefox.content_security_policy).toBe(chrome.content_security_policy.extension_pages);
  });
});
