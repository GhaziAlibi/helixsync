// How vite.config.ts builds the Chrome package.
export const chromeTarget = {
  outDir: "dist",
  manifest: "chrome/manifest.json",
  platform: "chrome/platform.ts",
  banner: undefined as string | undefined,
};
