// What scripts/check-package.mjs checks of @cherto/browser's packed tarball
// beyond the checks every package gets. The smoke test runs in plain Node, with
// no DOM, as server-side rendering imports the package.

const SMOKE_BODY = `
const noWindow = typeof window === "undefined";
const client = new ChertoClient({ clientKey: "ck_test", offline: true });
const result = {
  version: VERSION,
  manifest: manifest.version,
  noWindow,
  fallback: client.getVariant("missing", "fallback"),
  ready: client.getStatus().ready,
};
await client.close();
console.log(JSON.stringify(result));
`;

export default {
  files: [
    "CHANGELOG.md",
    "LICENSE",
    "README.md",
    "dist/index.cjs",
    "dist/index.d.cts",
    "dist/index.d.ts",
    "dist/index.js",
    "package.json",
  ],

  // Each prints a JSON object as its last line, compared with expected().
  smoke: {
    esm: `import { ChertoClient, VERSION } from "@cherto/browser";
import manifest from "@cherto/browser/package.json" with { type: "json" };
${SMOKE_BODY}`,
    cjs: `const { ChertoClient, VERSION } = require("@cherto/browser");
const manifest = require("@cherto/browser/package.json");
(async () => {
${SMOKE_BODY}
})().catch((err) => {
  console.error(err);
  process.exit(1);
});`,
    expected: (version) => ({
      version,
      manifest: version,
      noWindow: true,
      fallback: "fallback",
      ready: false,
    }),
  },

  consumer: `import { ChertoClient, VERSION } from "@cherto/browser";

type Options = ConstructorParameters<typeof ChertoClient>[0];

const options: Options = { clientKey: "ck_test", offline: true };

// @ts-expect-error sdkWrapper is internal
export const wrapped: Options = { clientKey: "ck_test", sdkWrapper: { name: "x", version: "1" } };

export async function run(): Promise<string> {
  const client = new ChertoClient(options);
  const variant: string = client.getVariant("checkout", "control");
  const ready: boolean = client.getStatus().ready;
  await client.close();
  return [VERSION, variant, ready].join(" ");
}
`,

  // No Node types: the package's own types must not need them.
  compilerOptions: { target: "es2020", lib: ["es2020", "dom"], types: [] },

  gzipBudget: 13.5 * 1024,
};
