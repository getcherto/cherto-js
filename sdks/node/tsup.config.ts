import { defineConfig } from "tsup";
import pkg from "./package.json" with { type: "json" };

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  // The private workspaces are unpublished, so inline their code and types:
  // the published package must not import any other @cherto/* package.
  dts: { resolve: true },
  noExternal: ["@cherto/eval-core", "@cherto/core"],
  platform: "node",
  target: "node22",
  removeNodeProtocol: false,
  sourcemap: false,
  clean: true,
  define: { __CHERTO_SDK_VERSION__: JSON.stringify(pkg.version) },
});
