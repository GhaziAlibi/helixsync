import { copyFileSync, cpSync, existsSync, mkdirSync } from "fs";
import { resolve } from "path";
import { defineConfig, type Plugin } from "vite";

/// Copies static extension assets (manifest.json, icons) into dist/ after
/// the JS/HTML build, since Vite only processes files reachable from a
/// declared rollup input.
function copyStaticAssets(): Plugin {
  return {
    name: "helixsync-copy-static-assets",
    closeBundle() {
      mkdirSync(resolve(__dirname, "dist"), { recursive: true });
      const files = ["manifest.json"];
      for (const file of files) {
        const src = resolve(__dirname, file);
        if (existsSync(src)) {
          copyFileSync(src, resolve(__dirname, "dist", file));
        }
      }
      const iconsDir = resolve(__dirname, "icons");
      if (existsSync(iconsDir)) {
        cpSync(iconsDir, resolve(__dirname, "dist", "icons"), { recursive: true });
      }
    },
  };
}

export default defineConfig({
  plugins: [copyStaticAssets()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: {
      input: {
        popup: resolve(__dirname, "popup.html"),
        background: resolve(__dirname, "src/background/index.ts"),
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === "background" ? "background.js" : "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
