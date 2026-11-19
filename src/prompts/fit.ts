import { prefix, suffix } from "./text.js";

/** A builder that does not exist, or an input or options it cannot build from. */
export class PromptError extends Error {
  override name = "PromptError";
}

const MIDDLE_CUT_MARKER =
  "\n… transcript middle redacted to fit the judge's budget …\n";

/** Keep the head and tail of `text`, cutting its middle to fit `maxUnits`. */
export function middleCut(text: string, maxUnits: number): string {
  if (text.length <= maxUnits) return text;
  const available = Math.max(0, maxUnits - MIDDLE_CUT_MARKER.length);
  const head = Math.floor(available / 2);
  return `${prefix(text, head)}${MIDDLE_CUT_MARKER}${suffix(text, available - head)}`;
}
