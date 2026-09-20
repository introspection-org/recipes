import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The supported Pi floor is written in three places — the peer range, the
 * `pi-minimum` CI job and the install docs. Twice in one day a bump moved one
 * and left the others proving or advertising a version we no longer support.
 */
describe("the Pi floor", () => {
  const root = join(import.meta.dirname, "..");
  const declared: string = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
    .peerDependencies["@earendil-works/pi-coding-agent"];
  const floor = declared.replace(/[^0-9.]/g, "");

  it("is a plain lower bound with no upper bound", () => {
    expect(declared).toMatch(/^>=\d+\.\d+\.\d+$/);
  });

  it("is what the install docs advertise", () => {
    const docs = readFileSync(join(root, "docs/pi-extension.md"), "utf8");
    expect(docs).toContain(`Pi \`>=${floor}\``);
  });

  it("is what the pi-minimum CI job installs", () => {
    const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
    // Derived from the range rather than copied, so no version literal remains.
    expect(ci).toContain("peerDependencies['@earendil-works/pi-coding-agent']");
    expect(ci).not.toMatch(/devDependencies\.@earendil-works\/pi-[a-z-]+=\d/);
  });
});
