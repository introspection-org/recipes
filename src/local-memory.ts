import { constants, lstatSync, realpathSync } from "node:fs";
import { access, mkdir, open } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  createReadToolDefinition,
  createWriteToolDefinition,
  createEditToolDefinition,
  detectSupportedImageMimeTypeFromFile,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { formatMemoryForPrompt, loadMemoryIndex } from "./memory.js";

const memoryRoot = "/workspace/memories";
const indexPath = memoryRoot + "/MEMORY.md";

function isMemoryPath(path: string): boolean {
  return path === memoryRoot || path.startsWith(memoryRoot + "/");
}

/** The host owns the private directory and its parent. Never follow links in the mount. */
export function bindLocalMemory(
  pi: ExtensionAPI,
  cwd: string,
  directory: string,
): string {
  if (
    !isAbsolute(directory) ||
    !lstatSync(resolve(directory), { throwIfNoEntry: false })?.isDirectory()
  ) {
    throw new Error(
      "--recipe-memory-dir or INTROSPECTION_MEMORY_DIR must name an existing absolute directory",
    );
  }
  const root = realpathSync(resolve(directory));
  function target(path: string) {
    if (realpathSync(root) !== root || !lstatSync(root).isDirectory())
      throw new Error("Memory directory was replaced");
    let current = root;
    for (const part of path.slice(memoryRoot.length).split("/")) {
      if (!part || part === ".") continue;
      if (part === ".." || part.includes("\\"))
        throw new Error("Invalid memory path");
      current = join(current, part);
      if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) {
        throw new Error("Memory paths cannot traverse symbolic links");
      }
    }
    return current;
  }

  async function readMemory(path: string) {
    const handle = await open(
      target(path),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  }

  async function writeMemory(path: string, content: string) {
    const flags =
      constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_TRUNC |
      constants.O_NOFOLLOW;
    const handle = await open(target(path), flags, 0o600);
    try {
      await handle.writeFile(content);
    } finally {
      await handle.close();
    }
  }

  const privateIndex = target(indexPath);
  const index = lstatSync(privateIndex, { throwIfNoEntry: false });
  if (index && !index.isFile())
    throw new Error("Memory index must be a regular file");
  const { memory, diagnostics } = loadMemoryIndex({
    cwd,
    indexPath: privateIndex,
  });
  if (diagnostics.length) throw new Error(diagnostics[0]!.message);

  // Choose the backend inside execute so Recipe hooks see the authored path,
  // and Pi retains its own tool schema, argument preparation and rendering.
  const read = createReadToolDefinition(cwd);
  pi.registerTool({
    ...read,
    execute(id, args, signal, update, ctx) {
      if (!isMemoryPath(args.path))
        return read.execute(id, args, signal, update, ctx);
      const file = () => target(args.path);
      return createReadToolDefinition(cwd, {
        operations: {
          access: () => access(file(), constants.R_OK),
          readFile: () => readMemory(args.path),
          detectImageMimeType: () =>
            detectSupportedImageMimeTypeFromFile(file()),
        },
      }).execute(id, args, signal, update, ctx);
    },
  });
  const write = createWriteToolDefinition(cwd);
  pi.registerTool({
    ...write,
    execute(id, args, signal, update, ctx) {
      if (!isMemoryPath(args.path))
        return write.execute(id, args, signal, update, ctx);
      return createWriteToolDefinition(cwd, {
        operations: {
          mkdir: async () => {
            const file = target(args.path);
            if (file !== root)
              await mkdir(dirname(file), { recursive: true, mode: 0o700 });
          },
          writeFile: (_, content) => writeMemory(args.path, content),
        },
      }).execute(id, args, signal, update, ctx);
    },
  });
  const edit = createEditToolDefinition(cwd);
  pi.registerTool({
    ...edit,
    execute(id, args, signal, update, ctx) {
      if (!isMemoryPath(args.path))
        return edit.execute(id, args, signal, update, ctx);
      const file = () => target(args.path);
      return createEditToolDefinition(cwd, {
        operations: {
          access: () => access(file(), constants.R_OK | constants.W_OK),
          readFile: () => readMemory(args.path),
          writeFile: (_, content) => writeMemory(args.path, content),
        },
      }).execute(id, args, signal, update, ctx);
    },
  });

  return formatMemoryForPrompt(
    memory && { ...memory, filePath: indexPath, baseDir: memoryRoot },
  );
}
