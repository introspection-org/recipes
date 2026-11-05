import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * True when the current process was launched with the given module as its
 * entry script. Compares realpaths: package-manager bin shims and
 * node_modules symlinks (pnpm) hand us a symlinked argv[1] while
 * import.meta.url is the real path, so naive equality would silently skip
 * the CLI main. Callers pass their own `import.meta.url`.
 */
export function isDirectEntry(
  moduleUrl: string,
  entry = process.argv[1],
): boolean {
  if (!entry) return false;

  const modulePath = fileURLToPath(moduleUrl);
  try {
    return realpathSync(entry) === realpathSync(modulePath);
  } catch {
    return resolve(entry) === modulePath;
  }
}
