import { existsSync, readFileSync, realpathSync } from "node:fs";
import { register } from "node:module";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const PI_PACKAGE = "@earendil-works/pi-coding-agent";

/** The installed Pi's package folder: `PI_PACKAGE_DIR`, else the `pi` on PATH. */
function piPackageDir(): string | undefined {
  if (process.env.PI_PACKAGE_DIR) return process.env.PI_PACKAGE_DIR;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const bin = join(dir, process.platform === "win32" ? "pi.cmd" : "pi");
    if (!dir || !existsSync(bin)) continue;
    let folder = dirname(realpathSync(bin));
    while (folder !== dirname(folder)) {
      const manifest = join(folder, "package.json");
      if (
        existsSync(manifest) &&
        (JSON.parse(readFileSync(manifest, "utf8")) as { name?: string })
          .name === PI_PACKAGE
      ) {
        return folder;
      }
      folder = dirname(folder);
    }
  }
  return undefined;
}

// Before anything imports Pi: this script is started by Node, not loaded by
// Pi, so Pi's packages are found in the installed Pi rather than supplied.
const pi = piPackageDir();
if (pi) {
  register("./resolve-hooks.js", import.meta.url, {
    data: { parentURL: pathToFileURL(join(pi, "package.json")).href },
  });
}
const { main } = await import("./cli-main.js");
await main(process.argv.slice(2));
