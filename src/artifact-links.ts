import type { ArtifactFile, ArtifactRepositorySource } from "./artifact.js";

export interface ArtifactLinkReference {
  path: string;
  file?: ArtifactFile;
  source?: ArtifactRepositorySource;
}

/** A host supplies URLs for the references it serves; no callback performs IO. */
export interface ArtifactLinkHost {
  workspaceRoot?: string;
  /** The document containing a relative link; omitted for conversation text. */
  fromPath?: string;
  file?: (file: ArtifactFile) => string | undefined;
  repository?: (source: ArtifactRepositorySource) => string | undefined;
  /** Defaults to the authored local link. A browser can return undefined. */
  path?: (path: string) => string | undefined;
}

export interface ResolvedArtifactLink<T extends ArtifactLinkReference> {
  artifact: T;
  /** Undefined when the host must open its artifact viewer instead of a URL. */
  href: string | undefined;
  fragment: string;
}

function normalizePath(path: string): string | undefined {
  const segments: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (segments.length === 0) return undefined;
      segments.pop();
    } else {
      segments.push(part);
    }
  }
  return segments.length > 0 ? segments.join("/") : undefined;
}

function workspacePath(
  href: string,
  host: ArtifactLinkHost,
): string | undefined {
  let destination = href;
  if (/^file:/i.test(href)) {
    let url: URL;
    try {
      url = new URL(href);
    } catch (error) {
      if (error instanceof TypeError) return undefined;
      throw error;
    }
    if ((url.hostname && url.hostname !== "localhost") || url.search)
      return undefined;
    destination = url.pathname;
  }
  let path: string;
  try {
    path = decodeURIComponent(destination);
  } catch (error) {
    if (error instanceof URIError) return undefined;
    throw error;
  }
  if (
    !path ||
    path !== path.trim() ||
    /[?\\]/.test(path) ||
    [...path].some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    ) ||
    path.startsWith("//")
  )
    return undefined;
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return undefined;
  if (path.startsWith("/")) {
    const root = host.workspaceRoot?.replace(/\/$/, "");
    if (!root || !path.startsWith(`${root}/`)) return undefined;
    return normalizePath(path.slice(root.length + 1));
  }
  const parent = host.fromPath?.split("/").slice(0, -1).join("/");
  return normalizePath(parent ? `${parent}/${path}` : path);
}

/** Resolve an explicit link against known artifacts; the latest matching reference wins. */
export function resolveArtifactLink<T extends ArtifactLinkReference>(
  href: string,
  artifacts: readonly T[],
  host: ArtifactLinkHost = {},
): ResolvedArtifactLink<T> | undefined {
  const hash = href.indexOf("#");
  const fragment = hash < 0 ? "" : href.slice(hash);
  const path = workspacePath(hash < 0 ? href : href.slice(0, hash), host);
  if (!path) return undefined;
  const artifact = [...artifacts]
    .reverse()
    .find((item) => normalizePath(item.path) === path);
  if (!artifact) return undefined;
  const mapped =
    (artifact.file && host.file?.(artifact.file)) ??
    (artifact.source && host.repository?.(artifact.source)) ??
    (host.path
      ? host.path(artifact.path)
      : hash < 0
        ? href
        : href.slice(0, hash));
  return {
    artifact,
    href:
      mapped === undefined
        ? undefined
        : fragment
          ? mapped.split("#", 1)[0] + fragment
          : mapped,
    fragment,
  };
}
