import { defineConfig } from "tsup";
import pkg from "./package.json" with { type: "json" };

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  platform: "browser",
  target: "es2020",
  // Lets a Server Component render ChertoProvider directly.
  banner: { js: '"use client";' },
  sourcemap: false,
  clean: true,
  define: { __CHERTO_SDK_VERSION__: JSON.stringify(pkg.version) },
});
