// What scripts/check-package.mjs checks of @cherto/react's packed tarball beyond
// the checks every package gets. The smoke test server-renders a provider in
// plain Node, with no DOM, as a framework's server render would.

const SMOKE_BODY = `
function Probe() {
  return createElement("p", null, useChertoVariant("missing", "fallback"));
}
const html = renderToString(
  createElement(
    ChertoProvider,
    { clientOptions: { clientKey: "ck_test", offline: true } },
    createElement(Probe),
  ),
);
console.log(JSON.stringify({ version: VERSION, manifest: manifest.version, html }));
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

  // Installed beside the tarball: its peers, and the types its consumer needs.
  // A workspace directory is packed from this checkout.
  install: ["sdks/browser", "react@^19", "react-dom@^19", "@types/react@^19"],

  // Each prints a JSON object as its last line, compared with expected().
  smoke: {
    esm: `import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { ChertoProvider, useChertoVariant, VERSION } from "@cherto/react";
import manifest from "@cherto/react/package.json" with { type: "json" };
${SMOKE_BODY}`,
    cjs: `const { createElement } = require("react");
const { renderToString } = require("react-dom/server");
const { ChertoProvider, useChertoVariant, VERSION } = require("@cherto/react");
const manifest = require("@cherto/react/package.json");
${SMOKE_BODY}`,
    expected: (version) => ({ version, manifest: version, html: "<p>fallback</p>" }),
  },

  consumer: `import { createElement, type ReactElement } from "react";
import {
  ChertoProvider,
  useChertoAssignment,
  useChertoVariant,
  VERSION,
  type ChertoProviderProps,
} from "@cherto/react";

export function Probe(): ReactElement {
  const variant: string = useChertoVariant("checkout", "control");
  const startedAt: string | undefined = useChertoAssignment("checkout")?.startedAt;
  return createElement("p", null, [VERSION, variant, startedAt].join(" "));
}

const props: ChertoProviderProps = {
  clientOptions: { clientKey: "ck_test", offline: true },
  context: { units: { user: "u_1" } },
  children: createElement(Probe),
};

export const app: ReactElement = createElement(ChertoProvider, props);
`,

  compilerOptions: { target: "es2020", lib: ["es2020", "dom"], types: [], jsx: "react-jsx" },
};
