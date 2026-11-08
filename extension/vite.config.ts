import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { defineConfig, type Plugin } from "vite";
import { chromeTarget } from "./chrome/target";
import { firefoxTarget } from "./firefox/target";

/// TARGET=firefox builds the Firefox package (firefox/) into dist-firefox/;
/// anything else builds the Chrome one (chrome/) into dist/. Shared code in
/// src/ reaches the browser-specific code only through `@platform`.
const target = process.env.TARGET === "firefox" ? firefoxTarget : chromeTarget;
const OUT_DIR = target.outDir;

/// Copies static extension assets (manifest.json, icons, _locales) into the
/// output after the JS/HTML build, since Vite only processes files reachable
/// from a declared rollup input.
function copyStaticAssets(): Plugin {
  return {
    name: "helixsync-copy-static-assets",
    closeBundle() {
      const out = resolve(__dirname, OUT_DIR);
      mkdirSync(out, { recursive: true });
      cpSync(resolve(__dirname, target.manifest), resolve(out, "manifest.json"));
      // Interface strings: the manifest's __MSG_*__ names and the popup's own
      // loader (src/i18n.ts) both read these.
      const localesDir = resolve(__dirname, "_locales");
      if (existsSync(localesDir)) {
        cpSync(localesDir, resolve(out, "_locales"), { recursive: true });
      }
      const iconsDir = resolve(__dirname, "icons");
      if (existsSync(iconsDir)) {
        cpSync(iconsDir, resolve(out, "icons"), { recursive: true });
      }
    },
  };
}

/// Writes THIRD_PARTY_LICENSES.txt into dist/: the license of every npm
/// package whose code ends up in the build, which those licenses require to
/// ship with it. Taken from the modules actually rendered into the output, so
/// build tools and tree-shaken packages are left out. The web dashboard's
/// vite.config.ts has the same plugin (each package builds on its own).
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
  plugins: [copyStaticAssets(), thirdPartyLicenses("The HelixSync extension")],
  resolve: {
    alias: { "@platform": resolve(__dirname, target.platform) },
  },
  build: {
    outDir: OUT_DIR,
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: {
      input: {
        popup: resolve(__dirname, "popup.html"),
        background: resolve(__dirname, "src/background/index.ts"),
      },
      output: {
        banner: target.banner,
        entryFileNames: (chunk) =>
          chunk.name === "background" ? "background.js" : "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
