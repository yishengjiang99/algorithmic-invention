import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { nitro } from "nitro/vite";

const base = process.env.VITE_BASE || "/";
const basepath = base.replace(/\/$/, "") || "/";

export default defineConfig(({ command, isPreview }) => ({
  base,
  server: {
    host: "0.0.0.0",
    port: 5173,
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
  },
  resolve: { tsconfigPaths: true },
  plugins: [
    tailwindcss(),
    tanstackStart({
      router: { basepath },
    }),
    ...(command === "build" || isPreview ? [nitro()] : []),
    viteReact(),
  ],
}));
