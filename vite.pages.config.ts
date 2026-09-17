import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";

const root = dirname(fileURLToPath(import.meta.url));
const base = process.env.VITE_BASE || "/algorithmic-invention/";

export default defineConfig({
  base,
  define: {
    "import.meta.env.VITE_SPA": JSON.stringify("1"),
  },
  resolve: { tsconfigPaths: true },
  plugins: [
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
      routesDirectory: resolve(root, "src/routes"),
      generatedRouteTree: resolve(root, "src/routeTree.gen.ts"),
    }),
    tailwindcss(),
    viteReact(),
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(root, "spa.html"),
    },
  },
});
