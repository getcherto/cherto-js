#!/usr/bin/env node
// Writes each SDK package's public API report, <dir>/etc/<name>.api.md, from its
// built dist/index.d.ts. With --check, fails instead when a report is out of date.
//
//   node scripts/api-report.mjs [--dir <package dir>]... [--check]
//
// Without --dir, covers every sdks/* package that isn't private. Run from the
// repository root after building the packages.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import * as prettier from "prettier";
import { publicPackageDirs } from "./check-package.mjs";

const { values: args } = parseArgs({
  options: {
    dir: { type: "string", multiple: true },
    check: { type: "boolean", default: false },
  },
});
const root = process.cwd();
const dirs = args.dir ?? publicPackageDirs(root);
if (!dirs.length) {
  console.error("no package to report on: every sdks/* package is private");
  process.exit(1);
}

let failed = false;
for (const dir of dirs) {
  if (!(await writeReport(dir))) failed = true;
}
if (failed) process.exit(1);

async function writeReport(dir) {
  const pkgDir = resolve(root, dir);
  const { name } = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  const report = `${dir}/etc/${name.split("/").at(-1)}.api.md`;
  const reportPath = join(root, report);

  if (!existsSync(join(pkgDir, "dist", "index.d.ts"))) {
    console.error(`${dir}/dist/index.d.ts is missing: build ${name} first`);
    return false;
  }

  const { Extractor, ExtractorConfig } = createRequire(join(pkgDir, "package.json"))(
    "@microsoft/api-extractor",
  );
  const config = ExtractorConfig.loadFileAndPrepare(join(pkgDir, "api-extractor.json"));
  let problems = 0;
  Extractor.invoke(config, {
    localBuild: true,
    messageCallback(message) {
      // Console notices describe api-extractor's own scratch copy of the report, and its
      // bundled TypeScript lagging this repo's; this script reports on the real one.
      if (message.category === "console" && message.logLevel !== "error") {
        message.handled = true;
      } else if (message.logLevel === "error" || message.logLevel === "warning") {
        problems++;
      }
    },
  });
  if (problems > 0) {
    console.error(
      `API Extractor reported problems in ${name}; fix them before updating the report`,
    );
    return false;
  }

  // Formatted as Prettier would, so the repository's format check leaves it alone.
  const generated = readFileSync(
    join(config.reportFolder, config.reportConfigs[0].fileName),
    "utf8",
  );
  const formatted = await prettier.format(generated, {
    ...(await prettier.resolveConfig(reportPath)),
    filepath: reportPath,
  });
  const current = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : null;

  if (current === formatted) {
    console.log(`${report} is up to date`);
  } else if (args.check) {
    console.error(
      `The public API changed, so ${report} is out of date. Run \`pnpm api-report\`, ` +
        "review the diff and commit it.",
    );
    return false;
  } else {
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, formatted);
    console.log(`updated ${report}; review the diff and commit it`);
  }
  return true;
}
