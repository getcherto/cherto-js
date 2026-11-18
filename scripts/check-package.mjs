#!/usr/bin/env node
// Packs each SDK package once and checks that tarball as npm would serve it:
// publint, arethetypeswrong, the packed manifest, no trace of the workspace
// packages the build inlines, the built VERSION, an install into fresh ESM and
// CommonJS projects that runs a smoke test, and a consumer typecheck, with the
// README's self-contained examples, under every TypeScript in the root
// devDependencies (`typescript` and its `npm:typescript@` aliases).
//
//   node scripts/check-package.mjs [--dir <package dir>]... [--out <dir>]
//
// What differs per package lives in its <dir>/scripts/package-check.mjs: the
// tarball's file allowlist, what to install beside it, the smoke test, the
// consumer, its compiler options and an optional gzip budget. A `jsx` compiler
// option adds the README's tsx examples. Without --dir, checks every sdks/*
// package that isn't private. Run from the repository root after building the
// packages. --out keeps the checked tarballs, so a release publishes exactly
// what was checked.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));

export const PUBLIC_REPOSITORY = "git+https://github.com/getcherto/cherto-js.git";

/** Packed files the allowlist lacks, and allowlisted files the tarball lacks. */
export function compareFiles(actual, allowed) {
  const have = new Set(actual);
  const want = new Set(allowed);
  return {
    unexpected: actual.filter((file) => !want.has(file)).sort(),
    missing: allowed.filter((file) => !have.has(file)).sort(),
  };
}

/** Every line of `files` that names a workspace-only package or protocol. */
export function findLeaks(files, needles = ["@cherto/core", "@cherto/eval-core", "workspace:"]) {
  const hits = [];
  for (const { path, text } of files) {
    for (const [index, line] of text.split("\n").entries()) {
      for (const needle of needles) {
        if (line.includes(needle)) hits.push(`${path}:${index + 1} mentions ${needle}`);
      }
    }
  }
  return hits;
}

/**
 * The Markdown's `lang` examples that import `packageName` and nothing but Node built-ins, so
 * a consumer typecheck can compile them as written.
 */
export function selfContainedExamples(markdown, packageName, lang = "ts") {
  return [...markdown.matchAll(new RegExp(`\`\`\`${lang}\\n([\\s\\S]*?)\`\`\``, "g"))]
    .map((match) => match[1])
    .filter((code) => {
      const sources = [...code.matchAll(/^import\b[^;]*?\bfrom\s+"([^"]+)"/gm)].map((m) => m[1]);
      return (
        sources.includes(packageName) &&
        sources.every((source) => source === packageName || source.startsWith("node:"))
      );
    });
}

/** `typescript` and every `npm:typescript@` alias among `devDependencies`. */
export function typescriptPackages(devDependencies = {}) {
  return Object.entries(devDependencies)
    .filter(([name, spec]) => name === "typescript" || spec.startsWith("npm:typescript@"))
    .map(([name]) => name)
    .sort();
}

/** The path of every `condition` key in an `exports` map, at any depth. */
export function conditionPaths(exports, condition, path = "exports") {
  if (!exports || typeof exports !== "object") return [];
  return Object.entries(exports).flatMap(([key, value]) => {
    const at = `${path}[${JSON.stringify(key)}]`;
    return key === condition ? [at] : conditionPaths(value, condition, at);
  });
}

/**
 * What's wrong with a packed manifest for publishing from `dir` of the public
 * repo. `access` is the only publishConfig key pnpm leaves in place; any other
 * is an override that wasn't applied.
 */
export function manifestProblems(manifest, dir, files) {
  const problems = [];
  if (manifest.private) problems.push("private is set, so npm refuses to publish it");
  for (const path of conditionPaths(manifest.exports, "development"))
    problems.push(`${path} is a development condition, which resolves to unpacked source`);
  for (const key of Object.keys(manifest.publishConfig ?? {}).filter((k) => k !== "access"))
    problems.push(`publishConfig.${key} was not applied when packing`);
  if (manifest.repository?.url !== PUBLIC_REPOSITORY)
    problems.push(`repository.url is ${manifest.repository?.url}, not ${PUBLIC_REPOSITORY}`);
  if (manifest.repository?.directory !== dir)
    problems.push(`repository.directory is ${manifest.repository?.directory}, not ${dir}`);
  if (manifest.exports?.["./package.json"] !== "./package.json")
    problems.push('exports has no "./package.json": "./package.json"');
  if (!files.includes("README.md")) problems.push("README.md is not packed");
  return problems;
}

/** The workspace's `sdks/*` packages that aren't private, as repository-relative dirs. */
export function publicPackageDirs(root) {
  const sdks = join(root, "sdks");
  if (!existsSync(sdks)) return [];
  return readdirSync(sdks, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(sdks, entry.name, "package.json")))
    .filter(
      (entry) => !JSON.parse(readFileSync(join(sdks, entry.name, "package.json"), "utf8")).private,
    )
    .map((entry) => `sdks/${entry.name}`)
    .sort();
}

export function formatKB(bytes) {
  return `${(bytes / 1024).toFixed(2)} KB`;
}

/** Runs one check, records whether it passed and logs its problems; a throw is one problem. */
export function runCheck(results, name, run, log = console.log) {
  let problems;
  try {
    problems = run();
  } catch (err) {
    problems = [err.stderr?.toString().trim() || err.message];
  }
  results.push({ name, ok: problems.length === 0 });
  log(`${problems.length ? "FAIL" : "ok  "} ${name}`);
  for (const problem of problems) log(`       ${problem.split("\n").join("\n       ")}`);
}

/** No problems when the tool exits 0; otherwise its output, or why it couldn't run. */
export function toolProblems(name, toolArgs, options = {}) {
  const { status, stdout, stderr, error } = spawnSync(name, toolArgs, {
    encoding: "utf8",
    ...options,
  });
  if (error) return [`${name}: ${error.message}`];
  return status === 0 ? [] : [`${stdout}${stderr}`.trim() || `${name} exited ${status}`];
}

const CONSUMERS = [
  { project: "esm", module: "node16", moduleResolution: "node16" },
  { project: "esm", module: "nodenext", moduleResolution: "nodenext" },
  { project: "esm", module: "esnext", moduleResolution: "bundler" },
  { project: "cjs", module: "node16", moduleResolution: "node16" },
  { project: "cjs", module: "nodenext", moduleResolution: "nodenext" },
];

const PROJECTS = {
  esm: { type: "module", file: "smoke.mjs" },
  cjs: { type: "commonjs", file: "smoke.cjs" },
};

function listFiles(dir, prefix = "") {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? listFiles(join(dir, entry.name), `${prefix}${entry.name}/`)
      : [`${prefix}${entry.name}`],
  );
}

const tarballName = (name, version) =>
  `${name.replace("@", "").replace("/", "-")}${version ? `-${version}` : ""}.tgz`;

/**
 * esbuild comes with tsup, the packages' bundler, so it is resolved through
 * tsup from the package rather than added to either root manifest.
 */
function loadEsbuild(pkgDir) {
  const fromPackage = createRequire(join(pkgDir, "package.json"));
  return createRequire(fromPackage.resolve("tsup/package.json"))("esbuild");
}

function pack(pkgDir, work) {
  const { name } = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  const tarball = join(work, tarballName(name));
  execFileSync("pnpm", ["pack", "--out", tarball], {
    cwd: pkgDir,
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, pnpm_config_pnpmfile: join(here, "pack-hooks.mjs") },
  });
  return tarball;
}

function checkPackage({ root, dir, pkgDir, profile, typescripts, work, check }) {
  const source = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  const tarball = pack(pkgDir, work);
  const beside = (profile.install ?? []).map((spec) =>
    existsSync(join(root, spec, "package.json")) ? pack(join(root, spec), work) : spec,
  );
  const unpacked = join(work, "unpacked");
  mkdirSync(unpacked);
  execFileSync("tar", ["-xzf", tarball, "-C", unpacked]);
  const packageRoot = join(unpacked, "package");
  const files = listFiles(packageRoot);
  const packed = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  const integrity = createHash("sha512").update(readFileSync(tarball)).digest("base64");
  console.log(
    `packed ${packed.name}@${packed.version}, ${files.length} files, sha512-${integrity}`,
  );

  check("tarball files match the profile's allowlist", () => {
    const { unexpected, missing } = compareFiles(files, profile.files);
    return [
      ...unexpected.map((file) => `unexpected: ${file}`),
      ...missing.map((file) => `missing: ${file}`),
    ];
  });
  check("packed package.json is publishable from the public repo", () =>
    manifestProblems(packed, dir, files),
  );
  check("no workspace packages in dist or the manifest", () =>
    findLeaks(
      files
        .filter((file) => file === "package.json" || file.startsWith("dist/"))
        .map((path) => ({ path, text: readFileSync(join(packageRoot, path), "utf8") })),
    ),
  );
  check("packed version matches package.json", () =>
    packed.version === source.version ? [] : [`${packed.version} != ${source.version}`],
  );
  check("publint --strict", () =>
    toolProblems(join(root, "node_modules/.bin/publint"), ["run", tarball, "--strict"]),
  );
  check("arethetypeswrong", () =>
    toolProblems(join(root, "node_modules/.bin/attw"), [tarball, "--format", "ascii"]),
  );

  const { compilerOptions } = profile;
  const typesNode = compilerOptions.types?.includes("node")
    ? realpathSync(join(pkgDir, "node_modules/@types/node"))
    : null;
  for (const [project, { type, file }] of Object.entries(PROJECTS)) {
    const projectDir = join(work, project);
    mkdirSync(join(projectDir, "node_modules/@types"), { recursive: true });
    writeFileSync(
      join(projectDir, "package.json"),
      `${JSON.stringify({ name: `smoke-${project}`, private: true, type })}\n`,
    );
    check(`install into a fresh ${type} project and run the smoke test`, () => {
      const install = toolProblems(
        "npm",
        [
          "install",
          tarball,
          ...beside,
          "--no-audit",
          "--no-fund",
          "--ignore-scripts",
          "--prefer-offline",
        ],
        { cwd: projectDir },
      );
      if (install.length) return install;
      writeFileSync(join(projectDir, file), profile.smoke[project]);
      const output = execFileSync("node", [file], {
        cwd: projectDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const result = JSON.parse(output.trim().split("\n").at(-1));
      return Object.entries(profile.smoke.expected(source.version))
        .filter(([key, value]) => result[key] !== value)
        .map(([key, value]) => `${key}: expected ${value}, got ${result[key]}`);
    });
    if (typesNode) symlinkSync(typesNode, join(projectDir, "node_modules/@types/node"), "dir");
    writeFileSync(join(projectDir, "consumer.ts"), profile.consumer);
  }

  if (profile.gzipBudget) {
    let size;
    check(`minified and gzipped, the ESM entry fits ${formatKB(profile.gzipBudget)}`, () => {
      const { outputFiles } = loadEsbuild(pkgDir).buildSync({
        stdin: {
          contents: `export * from ${JSON.stringify(packed.name)};`,
          resolveDir: join(work, "esm"),
          loader: "js",
        },
        bundle: true,
        minify: true,
        format: "esm",
        platform: "browser",
        write: false,
        logLevel: "silent",
      });
      size = gzipSync(outputFiles[0].contents).length;
      return size <= profile.gzipBudget ? [] : [`${formatKB(size)} is over the budget`];
    });
    if (size !== undefined) console.log(`       ${formatKB(size)}`);
  }

  // Top-level await needs an ES module, so only the module project compiles them.
  const readme = join(packageRoot, "README.md");
  const langs = compilerOptions.jsx ? ["ts", "tsx"] : ["ts"];
  const examples = existsSync(readme)
    ? langs.flatMap((lang) =>
        selfContainedExamples(readFileSync(readme, "utf8"), packed.name, lang).map((code) => ({
          code,
          lang,
        })),
      )
    : [];
  check("the README has a self-contained example to typecheck", () =>
    examples.length > 0
      ? []
      : [`no ${langs.join(" or ")} example imports only ${packed.name} and node: modules`],
  );
  const exampleFiles = examples.map(({ code, lang }, index) => {
    const file = `readme-example-${index + 1}.${lang}`;
    writeFileSync(join(work, "esm", file), code);
    return file;
  });

  for (const name of typescripts) {
    const tsDir = realpathSync(join(root, "node_modules", name));
    const { version } = JSON.parse(readFileSync(join(tsDir, "package.json"), "utf8"));
    for (const { project, module, moduleResolution } of CONSUMERS) {
      const tsconfig = `tsconfig.${moduleResolution}.json`;
      writeFileSync(
        join(work, project, tsconfig),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            noEmit: true,
            skipLibCheck: false,
            ...compilerOptions,
            module,
            moduleResolution,
          },
          files: project === "esm" ? ["consumer.ts", ...exampleFiles] : ["consumer.ts"],
        }),
      );
      const what = project === "esm" ? "module consumer and README examples" : "commonjs consumer";
      check(`typescript ${version}: ${what}, ${moduleResolution}`, () =>
        toolProblems("node", [join(tsDir, "bin/tsc"), "-p", tsconfig], {
          cwd: join(work, project),
        }),
      );
    }
  }

  return { tarball, name: packed.name, version: packed.version };
}

async function main() {
  const { values: args } = parseArgs({
    options: { dir: { type: "string", multiple: true }, out: { type: "string" } },
  });
  const root = process.cwd();
  const rootManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const dirs = (args.dir ?? publicPackageDirs(root)).map((dir) =>
    relative(root, resolve(root, dir)).split(sep).join("/"),
  );
  if (!dirs.length) {
    console.error("no package to check: every sdks/* package is private");
    process.exit(1);
  }
  const packages = [];
  for (const dir of dirs) {
    const pkgDir = resolve(root, dir);
    const profilePath = join(pkgDir, "scripts/package-check.mjs");
    if (!existsSync(join(pkgDir, "dist"))) {
      console.error(`${dir}/dist is missing; build the package first`);
      process.exit(1);
    }
    if (!existsSync(profilePath)) {
      console.error(`${dir}/scripts/package-check.mjs is missing; it says what to check`);
      process.exit(1);
    }
    const profile = (await import(pathToFileURL(profilePath))).default;
    for (const peer of profile.install ?? []) {
      if (existsSync(join(root, peer, "package.json")) && !existsSync(join(root, peer, "dist"))) {
        console.error(`${peer}/dist is missing; build it first, as ${dir} installs it`);
        process.exit(1);
      }
    }
    packages.push({ dir, pkgDir, profile });
  }

  const results = [];
  const typescripts = typescriptPackages(rootManifest.devDependencies);
  runCheck(results, "consumers are typechecked under at least two TypeScript versions", () =>
    typescripts.length >= 2 ? [] : [`root devDependencies have only: ${typescripts.join(", ")}`],
  );

  const work = mkdtempSync(join(tmpdir(), "check-package-"));
  const tarballs = [];
  try {
    for (const { dir, pkgDir, profile } of packages) {
      console.log(`\n${dir}`);
      const packageWork = join(work, dir.replaceAll("/", "-"));
      mkdirSync(packageWork);
      const prefix = packages.length > 1 ? `${dir}: ` : "";
      const check = (name, run) => runCheck(results, `${prefix}${name}`, run);
      try {
        tarballs.push(
          checkPackage({ root, dir, pkgDir, profile, typescripts, work: packageWork, check }),
        );
      } catch (err) {
        runCheck(results, `${prefix}pack and check`, () => {
          throw err;
        });
      }
    }

    if (args.out && results.every((result) => result.ok)) {
      mkdirSync(args.out, { recursive: true });
      for (const { tarball, name, version } of tarballs)
        copyFileSync(tarball, join(args.out, tarballName(name, version)));
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
