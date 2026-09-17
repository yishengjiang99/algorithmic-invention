#!/usr/bin/env node
import { copyFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const spa = join(dist, "spa.html");
const index = join(dist, "index.html");

if (!existsSync(spa) && !existsSync(index)) {
  throw new Error("pages build did not emit dist/spa.html or dist/index.html\n" + readdirSync(dist).join("\n"));
}
if (existsSync(spa) && !existsSync(index)) copyFileSync(spa, index);
copyFileSync(index, join(dist, "404.html"));
writeFileSync(join(dist, ".nojekyll"), "");
console.log("pages: index.html, 404.html, .nojekyll");
