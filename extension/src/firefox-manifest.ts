// Builds the Firefox manifest from manifest.json (the Chromium MV3 one), so
// the version and permissions have one source. Firefox gets MV2 with a
// persistent background page, which Firefox never suspends: the sync
// WebSocket and long imports stay alive without keep-alive tricks.
// Firefox for Android has no bookmarks or history API, so desktop only.

export const FIREFOX_MIN_VERSION = "115.0";

type Manifest = Record<string, unknown>;

export function firefoxManifest(chromium: Manifest): Manifest {
  const {
    manifest_version: _mv,
    minimum_chrome_version: _minChrome,
    background,
    action,
    optional_permissions,
    optional_host_permissions,
    content_security_policy,
    ...rest
  } = chromium;

  const bg = background as { service_worker: string; type?: string };
  const csp = content_security_policy as { extension_pages?: string } | undefined;

  return {
    manifest_version: 2,
    ...rest,
    browser_specific_settings: {
      gecko: { strict_min_version: FIREFOX_MIN_VERSION },
    },
    background: {
      scripts: [bg.service_worker],
      ...(bg.type ? { type: bg.type } : {}),
      persistent: true,
    },
    ...(action ? { browser_action: action } : {}),
    // MV2 has no optional_host_permissions: host patterns go with the
    // optional API permissions.
    optional_permissions: [
      ...((optional_permissions as string[] | undefined) ?? []),
      ...((optional_host_permissions as string[] | undefined) ?? []),
    ],
    ...(csp?.extension_pages ? { content_security_policy: csp.extension_pages } : {}),
  };
}
