// node --import ./test/support/register.mjs: resolve @earendil-works/* from the installed Pi
// (scripts/pi-root.mjs), so the tests run against the same pi-tui the extension gets at runtime.
import { registerHooks } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { piNodeModules } from "../../scripts/pi-root.mjs";

// Resolving from a file directly inside that node_modules finds its packages.
const anchor = pathToFileURL(join(piNodeModules(), "pi-sidebar-resolve-anchor.js")).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier.startsWith("@earendil-works/")
      ? nextResolve(specifier, { ...context, parentURL: anchor })
      : nextResolve(specifier, context);
  },
});
