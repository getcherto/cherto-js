#!/usr/bin/env node
// The snapshot hash a release commit records as `Snapshot: sha256:<hash>`: a
// digest of every file's path, executable bit and contents, so a tree can be
// checked against the export that was verified.
//
//   node scripts/snapshot-hash.mjs [dir]

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Order-independent digest of a tree's paths, executable bits and contents, used as its public provenance. */
export function contentHash(files) {
  const hash = createHash("sha256");
  const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  for (const { path, content, executable } of [...files].sort(byPath)) {
    hash
      .update(path)
      .update(executable ? "\0x\0" : "\0-\0")
      .update(content)
      .update("\0");
  }
  return hash.digest("hex");
}

/** {@link contentHash} of every file under `dir`, skipping `.git`. */
export function hashTree(dir) {
  const files = [];
  const walk = (relative) => {
    for (const entry of readdirSync(join(dir, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.name === ".git") continue;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        const full = join(dir, path);
        const executable = (statSync(full).mode & 0o111) !== 0;
        files.push({ path, content: readFileSync(full), executable });
      } else throw new Error(`${path} is neither a file nor a directory`);
    }
  };
  walk("");
  return contentHash(files);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(hashTree(process.argv[2] ?? "."));
}
