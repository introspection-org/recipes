/**
 * In recipe mode the agent is offered exactly the Recipe's skills: its own,
 * its dependency and peer packages' `pi.skills`, the `documents` tool's
 * core skill and profile, and the productivity tools' core skill. Skills Pi discovers anywhere else (an installed Pi
 * package, the user or project skills folder, `--skill`) never reach the
 * prompt or a `/skill:` command, under `pi --recipe` and the session API alike.
 */

import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LEGAL_REDLINING_EN_US } from "../packages/documents/docx/src/index.js";
import { DOCUMENTS_SKILL } from "../src/documents/index.js";
import { createRecipesExtension } from "../src/pi-extension.js";
import { resolveRecipe } from "../src/recipe/resolve.js";
import {
  createAgentSession,
  type RecipeSessionHandle,
} from "../src/session.js";
import { cleanEnv } from "../src/test-utils.js";

/**
 * Where companion packages resolve from when the Recipe omits the docx
 * package. The real companion beside this checkout only exists once built,
 * so a test points the fallback at a stand-in.
 */
const companionHost = vi.hoisted(() => ({
  dir: undefined as string | undefined,
}));

vi.mock("../src/recipe/companions.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/recipe/companions.js")>();
  return {
    ...actual,
    loadRecipePackageModule: (
      recipeDir: string,
      name: string,
      options: Parameters<typeof actual.loadRecipePackageModule>[2],
    ) =>
      actual.loadRecipePackageModule(recipeDir, name, {
        ...options,
        ...(companionHost.dir ? { hostDir: companionHost.dir } : {}),
      }),
  };
});

const DOCX = "@introspection-ai/recipe-documents-docx";
const scratch: string[] = [];
const sessions: Array<{ dispose(): unknown }> = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.dispose();
  for (const dir of scratch.splice(0))
    rmSync(dir, { recursive: true, force: true });
  companionHost.dir = undefined;
});

function write(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

function skill(name: string, description = `${name} guidance`): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\nFollow ${name}.\n`;
}

/** A stand-in docx format package that ships the real legal profile, so no Python runs. */
function writeDocxPackage(dir: string): void {
  write(
    join(dir, "package.json"),
    JSON.stringify({
      name: DOCX,
      version: "1.0.0",
      type: "module",
      main: "index.js",
    }),
  );
  write(
    join(dir, "index.js"),
    `export default { kind: "documents", format: "docx", extensions: [".docx"], capabilities: { read: true },
      profiles: { "legal-redlining-en-US": ${JSON.stringify(LEGAL_REDLINING_EN_US)} },
      createAdapter: () => ({ format: "docx", extensions: [".docx"], capabilities: { read: true }, read: async () => ({ text: "" }) }) };\n`,
  );
}

const PRODUCTIVITY = "@introspection-ai/recipe-productivity-fake";

/** A stand-in productivity provider serving `mail search`. */
function writeProductivityPackage(dir: string): void {
  write(
    join(dir, "package.json"),
    JSON.stringify({
      name: PRODUCTIVITY,
      version: "1.0.0",
      type: "module",
      main: "index.js",
    }),
  );
  write(
    join(dir, "index.js"),
    `export default { kind: "productivity", apiVersion: 1, provider: "fake",
      capabilities: { mail: { labels: "labels", folders: "labels", commands: { search: { effect: "read", backend: "rest" } } } },
      createSession: () => ({ provider: "fake", mail: { search: async () => ({ messages: [] }) } }) };\n`,
  );
}

type DocxSource = "dependency" | "peer" | "omitted";

/**
 * A Recipe with its own skill, a dependency and a peer package that declare
 * `pi.skills`, the docx format with the legal profile, and a productivity
 * provider whose `mail` tool offers the core productivity skill; plus foreign skills
 * Pi discovers on its own: a package installed into a fake Pi agent folder, a
 * user skill that shares a name with the Recipe's own, a project skill and a
 * `--skill` path.
 */
function world(docx: DocxSource) {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "recipe-skill-isolation-")),
  );
  scratch.push(root);
  const optDir = join(root, "opt");
  const recipeDir = join(optDir, "recipe");
  const projectDir = join(root, "project");
  const piAgentDir = join(root, "pi-agent");

  // The Recipe.
  const dependencies: Record<string, string> = {
    "acme-dep-skills": ">=1.0.0",
    [PRODUCTIVITY]: ">=1.0.0",
  };
  const peerDependencies: Record<string, string> = {
    "acme-peer-skills": ">=1.0.0",
  };
  if (docx === "dependency") dependencies[DOCX] = ">=1.0.0";
  if (docx === "peer") peerDependencies[DOCX] = ">=1.0.0";
  write(
    join(recipeDir, "package.json"),
    JSON.stringify({
      name: "isolated-recipe",
      version: "0.1.0",
      type: "module",
      dependencies,
      peerDependencies,
      pi: {
        documents: [{ format: "docx", profile: "legal-redlining-en-US" }],
        productivity: [{ provider: "fake", tools: { mail: ["search"] } }],
      },
    }),
  );
  write(
    join(recipeDir, "agents", "agent.yaml"),
    [
      "name: agent",
      "model:",
      "  name: anthropic/claude-sonnet-4-5",
      "tools: [read, documents, mail]",
      "skills: [recipe-own, dep-skill, peer-skill]",
      "",
    ].join("\n"),
  );
  write(
    join(recipeDir, "skills", "recipe-own", "SKILL.md"),
    skill("recipe-own", "Recipe-owned guidance"),
  );
  // A dependency in the Recipe's node_modules, and a peer the platform provides above it.
  const depDir = join(recipeDir, "node_modules", "acme-dep-skills");
  write(
    join(depDir, "package.json"),
    JSON.stringify({
      name: "acme-dep-skills",
      version: "1.0.0",
      pi: { skills: ["skills"] },
    }),
  );
  write(join(depDir, "skills", "dep-skill", "SKILL.md"), skill("dep-skill"));
  const peerDir = join(optDir, "node_modules", "acme-peer-skills");
  write(
    join(peerDir, "package.json"),
    JSON.stringify({
      name: "acme-peer-skills",
      version: "1.0.0",
      pi: { skills: ["skills"] },
    }),
  );
  write(join(peerDir, "skills", "peer-skill", "SKILL.md"), skill("peer-skill"));
  writeProductivityPackage(
    join(recipeDir, "node_modules", ...PRODUCTIVITY.split("/")),
  );
  if (docx === "dependency")
    writeDocxPackage(join(recipeDir, "node_modules", ...DOCX.split("/")));
  if (docx === "peer")
    writeDocxPackage(join(optDir, "node_modules", ...DOCX.split("/")));
  if (docx === "omitted") {
    // The companion copy installed beside the running Recipes.
    const hostModules = join(root, "host", "node_modules");
    const hostDir = join(hostModules, "@introspection-ai", "recipes");
    write(
      join(hostDir, "package.json"),
      JSON.stringify({ name: "@introspection-ai/recipes", version: "0.0.0" }),
    );
    writeDocxPackage(join(hostModules, ...DOCX.split("/")));
    companionHost.dir = hostDir;
  }

  // What Pi discovers by itself: a package installed globally (as
  // `pi install` records it), a user skill named like the Recipe's own, a
  // project skill, and a `--skill` path.
  const globalPackage = join(root, "global", "operator-package");
  write(
    join(globalPackage, "package.json"),
    JSON.stringify({
      name: "operator-package",
      version: "1.0.0",
      pi: { skills: ["skills"] },
    }),
  );
  write(
    join(globalPackage, "skills", "build-draft", "SKILL.md"),
    skill("build-draft", "FOREIGN package skill"),
  );
  write(
    join(piAgentDir, "settings.json"),
    JSON.stringify({ packages: [globalPackage] }),
  );
  write(
    join(piAgentDir, "skills", "global-user", "SKILL.md"),
    skill("global-user", "FOREIGN user skill"),
  );
  write(
    join(piAgentDir, "skills", "recipe-own", "SKILL.md"),
    skill("recipe-own", "FOREIGN shadow of the Recipe's own"),
  );
  write(
    join(projectDir, ".pi", "skills", "project-skill", "SKILL.md"),
    skill("project-skill", "FOREIGN project skill"),
  );
  const cliSkill = join(root, "cli-skills", "cli-skill");
  write(join(cliSkill, "SKILL.md"), skill("cli-skill", "FOREIGN --skill path"));

  return {
    recipeDir,
    projectDir,
    piAgentDir,
    cliSkill,
    ownSkill: join(recipeDir, "skills", "recipe-own", "SKILL.md"),
    depSkill: join(depDir, "skills", "dep-skill", "SKILL.md"),
    peerSkill: join(peerDir, "skills", "peer-skill", "SKILL.md"),
  };
}

type World = ReturnType<typeof world>;

const FOREIGN = [
  "build-draft",
  "global-user",
  "project-skill",
  "cli-skill",
] as const;
const OFFERED = [
  "recipe-own",
  "dep-skill",
  "peer-skill",
  "documents",
  "legal-redlining-en-us",
  "productivity",
] as const;

async function credentials(): Promise<InMemoryCredentialStore> {
  const store = new InMemoryCredentialStore();
  await store.modify("anthropic", async () => ({
    type: "api_key",
    key: "test-key",
  }));
  return store;
}

/** The provider request Pi builds for a prompt, captured before it is sent. */
async function requestFor(
  session: AgentSession,
  text = "hello",
): Promise<string> {
  let payload: unknown;
  session.agent.onPayload = async (next) => {
    payload = next;
    throw new Error("request captured");
  };
  await session.prompt(text).catch(() => {});
  if (payload === undefined) throw new Error("Pi built no provider request");
  return JSON.stringify(payload);
}

/** The `<available_skills>` names in a captured request. */
function offeredSkillNames(request: string): string[] {
  return [...request.matchAll(/<name>([^<]+)<\/name>/g)]
    .map((match) => match[1]!)
    .sort();
}

/** `pi --recipe <dir>`: Pi's own resource discovery with the Recipes extension loaded. */
async function launchPi(
  fixture: World,
  options: { noSkills?: boolean } = {},
): Promise<AgentSession> {
  const modelRuntime = await ModelRuntime.create({
    credentials: await credentials(),
    modelsPath: null,
  });
  const services = await createAgentSessionServices({
    cwd: fixture.projectDir,
    agentDir: fixture.piAgentDir,
    modelRuntime,
    extensionFlagValues: new Map([["recipe", fixture.recipeDir]]),
    resourceLoaderOptions: {
      extensionFactories: [createRecipesExtension({ env: cleanEnv() })],
      additionalSkillPaths: [fixture.cliSkill],
      ...(options.noSkills ? { noSkills: true } : {}),
    },
  });
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(fixture.projectDir),
  });
  sessions.push(session);
  await session.bindExtensions({});
  return session;
}

describe("recipe mode offers only the Recipe's skills", () => {
  it("Pi discovers the foreign skills in this world, so the tests below are meaningful", async () => {
    const fixture = world("dependency");
    const session = await launchPi(fixture);
    const discovered = session.resourceLoader
      .getSkills()
      .skills.map((loaded) => loaded.name);
    expect(discovered).toEqual(
      expect.arrayContaining(["build-draft", "global-user", "cli-skill"]),
    );
    // The user skill wins Pi's name collision over the Recipe's own.
    expect(
      session.resourceLoader
        .getSkills()
        .skills.find((loaded) => loaded.name === "recipe-own")?.description,
    ).toContain("FOREIGN");
  });

  describe.each<DocxSource>(["dependency", "peer", "omitted"])(
    "pi --recipe, docx package as a %s",
    (docx) => {
      it.each([false, true])(
        "prompts with the Recipe's skills alone (--no-skills: %s)",
        async (noSkills) => {
          const fixture = world(docx);
          const session = await launchPi(fixture, { noSkills });
          const request = await requestFor(session);

          expect(offeredSkillNames(request)).toEqual([...OFFERED].sort());
          for (const name of FOREIGN) expect(request).not.toContain(name);
          expect(request).not.toContain("FOREIGN");
          expect(request).toContain("Recipe-owned guidance");
          for (const path of [
            fixture.ownSkill,
            fixture.depSkill,
            fixture.peerSkill,
            DOCUMENTS_SKILL,
            LEGAL_REDLINING_EN_US,
          ]) {
            expect(request).toContain(JSON.stringify(path).slice(1, -1));
          }
        },
      );
    },
  );

  it("expands /skill: only for the Recipe's skills, and from the Recipe's file", async () => {
    const fixture = world("dependency");
    const session = await launchPi(fixture);

    const own = await requestFor(session, "/skill:recipe-own now");
    expect(own).toContain(
      `<skill name=\\"recipe-own\\" location=\\"${fixture.ownSkill}\\">`,
    );
    expect(own).toContain("now");

    for (const name of ["build-draft", "global-user"]) {
      let built = false;
      session.agent.onPayload = async () => {
        built = true;
        throw new Error("request captured");
      };
      await session.prompt(`/skill:${name}`).catch(() => {});
      expect(built).toBe(false);
    }
  });
});

describe("the session API offers only the Recipe's skills", () => {
  async function open(
    fixture: World,
    options: Partial<Parameters<typeof createAgentSession>[0]> = {},
  ) {
    const handle: RecipeSessionHandle = await createAgentSession({
      recipe: resolveRecipe({ recipeDir: fixture.recipeDir }),
      credentials: await credentials(),
      env: cleanEnv(),
      cwd: fixture.projectDir,
      ...options,
    });
    sessions.push(handle);
    return handle;
  }

  it.each<DocxSource>(["dependency", "peer", "omitted"])(
    "offers the Recipe's, its packages' and the documents skills, docx as a %s, and nothing an extension adds",
    async (docx) => {
      const fixture = world(docx);
      const handle = await open(fixture, {
        // A host extension that offers a skill the way a Pi package would.
        extensionFactories: [
          (pi) => {
            pi.on("resources_discover", () => ({
              skillPaths: [fixture.cliSkill],
            }));
          },
        ],
      });

      const loaded = handle.session.resourceLoader.getSkills().skills;
      expect(loaded.map((entry) => entry.name).sort()).toEqual(
        [...OFFERED].sort(),
      );
      const request = await requestFor(handle.session);
      expect(offeredSkillNames(request)).toEqual([...OFFERED].sort());
      expect(request).not.toContain("FOREIGN");
    },
  );

  it("keeps a host's explicit additionalSkillPaths", async () => {
    const fixture = world("dependency");
    const handle = await open(fixture, {
      additionalSkillPaths: [fixture.cliSkill],
    });
    expect(
      handle.session.resourceLoader
        .getSkills()
        .skills.map((entry) => entry.name),
    ).toContain("cli-skill");
  });

  it("keeps a relative additionalSkillPaths entry, resolved against the session cwd", async () => {
    const fixture = world("dependency");
    // The session's cwd is the project folder, not the process's.
    expect(process.cwd()).not.toBe(fixture.projectDir);
    const relativePath = relative(fixture.projectDir, fixture.cliSkill);
    const handle = await open(fixture, {
      additionalSkillPaths: [` ${relativePath} `],
    });
    expect(
      handle.session.resourceLoader
        .getSkills()
        .skills.map((entry) => entry.name),
    ).toContain("cli-skill");
  });
});
