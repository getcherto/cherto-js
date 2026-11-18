// What scripts/check-package.mjs checks of @cherto/node's packed tarball beyond
// the checks every package gets.

const CONFIG = {
  version: 1,
  configHash: "smoke",
  experiments: [
    {
      key: "all-on",
      status: "running",
      salt: "smoke:all-on",
      trafficPercentage: 100,
      unitTypeKey: "user",
      variants: [{ key: "on", allocationPercentage: 100 }],
    },
    {
      key: "concluded",
      status: "concluded",
      concludedVariant: "winner",
      salt: "smoke:concluded",
      trafficPercentage: 100,
      unitTypeKey: "user",
      variants: [
        { key: "control", allocationPercentage: 50 },
        { key: "winner", allocationPercentage: 50 },
      ],
    },
  ],
};

const SMOKE_BODY = `
const client = await ChertoClient.init({
  serverKey: "",
  offline: true,
  initialConfig: ${JSON.stringify(CONFIG)},
});
const ctx = client.context({ units: { user: "u_1" } });
const result = {
  version: VERSION,
  manifest: manifest.version,
  allOn: ctx.getVariant("all-on", "off"),
  concluded: ctx.getVariant("concluded", "control"),
  missing: ctx.getVariant("missing", "fallback"),
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
    esm: `import { ChertoClient, VERSION } from "@cherto/node";
import manifest from "@cherto/node/package.json" with { type: "json" };
${SMOKE_BODY}`,
    cjs: `const { ChertoClient, VERSION } = require("@cherto/node");
const manifest = require("@cherto/node/package.json");
(async () => {
${SMOKE_BODY}
})().catch((err) => {
  console.error(err);
  process.exit(1);
});`,
    expected: (version) => ({
      version,
      manifest: version,
      allOn: "on",
      concluded: "winner",
      missing: "fallback",
    }),
  },

  consumer: `import { ChertoClient, ChertoError, VERSION, isChertoError } from "@cherto/node";
import type {
  ChertoAssignmentDetail,
  ChertoClientOptions,
  ChertoClientStatus,
  ChertoContext,
} from "@cherto/node";

const options: ChertoClientOptions = {
  serverKey: "",
  offline: true,
  initialConfig: { version: 1, experiments: [] },
};

export async function run(): Promise<string> {
  const client: ChertoClient = await ChertoClient.init(options);
  const ctx: ChertoContext = client.context({ units: { user: "u_1" }, attributes: { plan: "pro" } });
  const variant: string = ctx.getVariant("checkout", "control");
  const detail: ChertoAssignmentDetail = ctx.getAssignmentDetail("checkout");
  const status: ChertoClientStatus = client.getStatus();
  await client.close();
  const error: unknown = new ChertoError("network", "offline");
  const retryable = isChertoError(error) && error.retryable;
  return [VERSION, variant, detail.reason, status.ready, retryable].join(" ");
}
`,

  compilerOptions: { target: "es2022", types: ["node"] },
};
