import { resolve } from "node:path";

import type { ChannelEnvironment } from "@introspection-ai/recipes/channels";

export function slackDownloadRoot(
  env: ChannelEnvironment = process.env,
  cwd: string = process.cwd(),
): string {
  const runtimeFiles = env.INTROSPECTION_RUNTIME_FILES_DIR?.trim();
  return resolve(runtimeFiles || resolve(cwd, "files"), "slack");
}
