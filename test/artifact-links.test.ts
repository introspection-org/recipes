import { describe, expect, it } from "vitest";
import {
  resolveArtifactLink,
  type ArtifactLinkReference,
} from "../src/review.js";

const local = { path: "outputs/report.md" };
const stored = { ...local, file: { id: "file/one", bytes: 20 } };
const repository = {
  path: "app/docs/guide.md",
  source: {
    repository_id: "repo-id",
    commit: "recorded-commit",
    path: "docs/guide.md",
  },
};

describe("shared artifact links", () => {
  it("uses the same known artifact as a local link or a host-specific file URL", () => {
    expect(resolveArtifactLink("outputs/report.md", [stored])?.href).toBe(
      "outputs/report.md",
    );
    expect(
      resolveArtifactLink("outputs/report.md#summary", [stored], {
        file: (file) => `/files/${encodeURIComponent(file.id)}`,
        path: () => undefined,
      }),
    ).toMatchObject({
      artifact: stored,
      href: "/files/file%2Fone#summary",
      fragment: "#summary",
    });
  });

  it("retains an unuploaded local link and lets a browser use its existing viewer", () => {
    expect(resolveArtifactLink("./outputs/report.md", [local])?.href).toBe(
      "./outputs/report.md",
    );
    expect(
      resolveArtifactLink("outputs/report.md", [local], {
        path: () => undefined,
      }),
    ).toEqual({
      artifact: local,
      href: undefined,
      fragment: "",
    });
  });

  it("passes the pinned repository reference to the host", () => {
    const resolved = resolveArtifactLink("app/docs/guide.md", [repository], {
      repository: (source) =>
        `/repositories/${source.repository_id}/${source.commit}/${source.path}`,
    });
    expect(resolved?.href).toBe(
      "/repositories/repo-id/recorded-commit/docs/guide.md",
    );
    expect(resolved?.artifact).toBe(repository);
  });

  it("resolves encoded paths and links relative to a document", () => {
    const artifact = { path: "outputs/My Report.md" };
    expect(
      resolveArtifactLink("../outputs/My%20Report.md", [artifact], {
        fromPath: "docs/brief.md",
      })?.artifact,
    ).toBe(artifact);
    expect(
      resolveArtifactLink("../outputs/My%20Report.md", [artifact], {
        fromPath: "docs/brief.md",
      })?.href,
    ).toBe("../outputs/My%20Report.md");
    expect(
      resolveArtifactLink("guide.md", [repository], {
        fromPath: "app/docs/index.md",
      })?.artifact,
    ).toBe(repository);
  });

  it("accepts only absolute paths inside the declared workspace", () => {
    expect(
      resolveArtifactLink("/workspace/outputs/report.md", [stored], {
        workspaceRoot: "/workspace",
      })?.artifact,
    ).toBe(stored);
    expect(
      resolveArtifactLink("/workspace-other/outputs/report.md", [stored], {
        workspaceRoot: "/workspace",
      }),
    ).toBeUndefined();
    expect(
      resolveArtifactLink("/workspace/../outputs/report.md", [stored], {
        workspaceRoot: "/workspace",
      }),
    ).toBeUndefined();
    expect(
      resolveArtifactLink("/workspace/outputs/report.md", [stored]),
    ).toBeUndefined();
  });

  it("maps local file URLs only within the host's known workspace", () => {
    const href = "file:///workspace/outputs/report.md";
    expect(
      resolveArtifactLink(href, [stored], { workspaceRoot: "/workspace" })
        ?.href,
    ).toBe(href);
    expect(
      resolveArtifactLink(href, [stored], {
        workspaceRoot: "/workspace",
        file: (file) => `/files/${file.id}`,
      })?.href,
    ).toBe("/files/file/one");
    expect(resolveArtifactLink(href, [stored])).toBeUndefined();
    expect(
      resolveArtifactLink(
        "file://remote/workspace/outputs/report.md",
        [stored],
        { workspaceRoot: "/workspace" },
      ),
    ).toBeUndefined();
    expect(
      resolveArtifactLink("file:///outside/outputs/report.md", [stored], {
        workspaceRoot: "/workspace",
      }),
    ).toBeUndefined();
  });

  it("never guesses by basename or resolves an unrecorded file", () => {
    expect(resolveArtifactLink("report.md", [stored])).toBeUndefined();
    expect(resolveArtifactLink("outputs/missing.md", [stored])).toBeUndefined();
    expect(resolveArtifactLink("outputs/report.md", [])).toBeUndefined();
  });

  it("uses the latest reference for repeated shows of the exact same path", () => {
    const revised = { ...stored, file: { id: "version-two", bytes: 30 } };
    expect(
      resolveArtifactLink("outputs/report.md", [stored, revised])?.artifact,
    ).toBe(revised);
  });

  it.each([
    "https://example.com/outputs/report.md",
    "javascript:outputs/report.md",
    " javascript:outputs/report.md",
    "javascript%3Aoutputs/report.md",
    "data:outputs/report.md",
    "//example.com/outputs/report.md",
    "../outputs/report.md",
    "outputs/%E0%A4",
    "outputs/%00report.md",
    "#summary",
    "outputs/report.md?download=1",
    "outputs\\report.md",
  ])(
    "leaves external, malformed or non-workspace destinations alone: %s",
    (href) => {
      const references: ArtifactLinkReference[] = [
        stored,
        { path: "javascript:outputs/report.md" },
      ];
      expect(resolveArtifactLink(href, references)).toBeUndefined();
    },
  );
});
