import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  js.configs.recommended,
  tseslint.configs.recommended,
  prettier,
  {
    ignores: ["**/dist/", "**/.next/", "**/node_modules/", "**/.turbo/"],
  },
  {
    // tseslint's recommended set turns this off because tsc reports TS1117, but
    // tsc never sees files a package's typecheck excludes, such as its tests.
    rules: { "no-dupe-keys": "error" },
  },
);
