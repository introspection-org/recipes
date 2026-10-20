// An extension module, so the docs' top-level await runs when Pi loads it.
// #region docs:build/tools/python-script
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const { stdout } = await promisify(execFile)("python", ["scripts/reconcile.py"], {
  cwd: new URL("..", import.meta.url),
});
// #endregion docs:build/tools/python-script

export const reconciled = stdout;
