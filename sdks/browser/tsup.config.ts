import { defineConfig } from "tsup";
import pkg from "./package.json" with { type: "json" };

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  // The private workspaces are unpublished, so inline their code and types:
  // the published package must not import any other @cherto/* package.
  dts: { resolve: true, compilerOptions: { stripInternal: true } },
  noExternal: ["@cherto/core"],
  platform: "browser",
  target: "es2020",
  sourcemap: false,
  clean: true,
  define: { __CHERTO_SDK_VERSION__: JSON.stringify(pkg.version) },
});
