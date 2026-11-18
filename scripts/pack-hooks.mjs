// pnpmfile that check-package.mjs packs with. devDependencies name the
// unpublished workspace packages the build inlines, and nothing installs them
// from a published manifest, so they are dropped from it.

export const hooks = {
  beforePacking(manifest) {
    delete manifest.devDependencies;
    return manifest;
  },
};
