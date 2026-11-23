import type { RecipeSessionHandle } from "../../src/index.js";
import { MEMORY_SNAPSHOT_ENTRY } from "../../src/memory-context.js";

/** The memory snapshot saved on a session's active branch, if any. */
export function memorySnapshot(
  handle: RecipeSessionHandle,
): string | undefined {
  return handle.session.sessionManager
    .getBranch()
    .flatMap((entry) =>
      entry.type === "custom" && entry.customType === MEMORY_SNAPSHOT_ENTRY
        ? [(entry.data as { content: string }).content]
        : [],
    )
    .at(-1);
}
