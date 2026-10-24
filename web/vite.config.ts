import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

/// Writes THIRD_PARTY_LICENSES.txt into dist/: the license of every npm
/// package whose code ends up in the build, which those licenses require to
/// ship with it. Taken from the modules actually rendered into the output, so
/// build tools and tree-shaken packages are left out. The extension's
/// vite.config.ts has the same plugin: the web image builds from web/ alone,
/// so the two can't share a file.
function thirdPartyLicenses(product: string): Plugin {
  return {
    name: "helixsync-third-party-licenses",
    generateBundle(_options, bundle) {
      // Vite module ids use "/" on every OS.
      const marker = "/node_modules/";
      const packageDirs = new Set<string>();
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue;
        for (const [id, module] of Object.entries(output.modules)) {
          const at = id.lastIndexOf(marker);
          if (at === -1 || module.renderedLength === 0) continue;
          const parts = id.slice(at + marker.length).split("/");
          const name = parts[0].startsWith("@") ? parts.slice(0, 2) : parts.slice(0, 1);
          packageDirs.add(id.slice(0, at + marker.length) + name.join("/"));
        }
      }

      const sections = [...packageDirs].map((dir) => {
        const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
        const licenseFiles = readdirSync(dir)
          .filter((file) => /^(licen[cs]e|copying|notice)(\.|-|$)/i.test(file))
          .sort();
        const texts = licenseFiles.map((file) => readFileSync(join(dir, file), "utf8").trim());
        const heading = `${pkg.name} ${pkg.version} (${pkg.license ?? "license not stated"})`;
        const body = texts.length > 0 ? texts.join("\n\n") : "The package ships no license file.";
        return { name: pkg.name as string, text: `${"-".repeat(72)}\n${heading}\n${"-".repeat(72)}\n\n${body}\n` };
      });
      sections.sort((a, b) => a.name.localeCompare(b.name));

      this.emitFile({
        type: "asset",
        fileName: "THIRD_PARTY_LICENSES.txt",
        source: `${product} includes the following third-party packages.\n\n${sections.map((s) => s.text).join("\n")}`,
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), thirdPartyLicenses("The HelixSync web dashboard")],
  server: {
    port: 5173,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  test: {
    // The units under test (crypto, the REST client, small pure helpers) need
    // no DOM: Node provides fetch, WebCrypto, atob/btoa. Component behaviour
    // is not covered here.
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
