import { defineConfig, type Options } from "tsup";

const MINIMUM_NODE_MAJOR = 24;

// Runs before anything else in the bundle so an old Node gets a message instead of a stack trace
// undici is CommonJS and requires Node builtins at load time; an ESM bundle needs a require to hand it
const requireShim = `
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
`;

const nodeVersionGuard = `
(() => {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < ${MINIMUM_NODE_MAJOR}) {
    process.stderr.write("prx needs Node ${MINIMUM_NODE_MAJOR} or newer, found " + process.versions.node + "\\n");
    process.exit(1);
  }
})();
`;

export const bundleOptions: Options = {
  entry: { prx: "src/bin.ts" },
  format: "esm",
  platform: "node",
  // Kept older than the runtime floor so the guard runs instead of a syntax error on old Node
  target: "node20",
  noExternal: [/./],
  banner: { js: `#!/usr/bin/env node${nodeVersionGuard}${requireShim}` },
  clean: true,
};

export default defineConfig(bundleOptions);
