import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export const DEFAULT_REPO = "seanGSISG/cc-plugins";

// A mistake in what the user asked for; the CLI prints the message without a stack trace.
export class UsageError extends Error {}

// A CLI the pack's skills call. `auth` reports sign-in status: a JSON `authenticated` field when it prints
// one, otherwise its exit code. `login` signs in through the browser (OAuth). `apiKey` is the fallback:
// its `login` argv gets the pasted key appended (`octen login --api-key <key>`); `url` is where to make one.
const Tool = z.strictObject({
  package: z.string(),
  command: z.string(),
  auth: z.array(z.string()).nonempty().optional(),
  login: z.array(z.string()).nonempty().optional(),
  apiKey: z.strictObject({ login: z.array(z.string()).nonempty(), url: z.url().optional() }).optional(),
});
export type Tool = z.infer<typeof Tool>;

// `skillpack.json`, next to a plugin's `.claude-plugin/plugin.json`: what the pack needs beyond its skills.
// Strict: an unknown key (a typo, or a field this skillpack predates) is an error, not silently dropped.
export const Manifest = z.strictObject({
  uv: z.boolean().default(false),
  // Installed with `uv tool install`.
  uvTools: z.array(Tool).default([]),
  // Installed with `npm install -g`; Node is already present, since skillpack runs on it.
  npmTools: z.array(Tool).default([]),
  // Remote MCP servers for non-Claude agents; Claude Code gets them through plugin dependencies.
  mcpServers: z.record(z.string(), z.url()).default({}),
  // Marketplace name -> GitHub repo, for marketplaces the plugin's dependencies live in.
  claudeMarketplaces: z.record(z.string(), z.string()).default({}),
  // Skills from other repos that non-Claude agents need (Claude Code gets them as plugin dependencies).
  skillSources: z
    .array(z.strictObject({ source: z.string(), skills: z.array(z.string()).nonempty() }))
    .default([]),
});
export type Manifest = z.infer<typeof Manifest>;

export const PluginJson = z.object({
  name: z.string(),
  version: z.string().optional(),
  dependencies: z
    .array(z.union([z.string(), z.object({ name: z.string(), marketplace: z.string().optional() })]))
    .default([]),
});

export const MarketplaceJson = z.object({
  name: z.string(),
  plugins: z.array(z.object({ name: z.string(), source: z.unknown() })),
});

export interface Pack {
  name: string;
  marketplace: string;
  repo: string;
  ref: string;
  // Pack directory relative to the repo root, e.g. `plugins/web-tool-routing`.
  path: string;
  skills: string[];
  // Marketplace names this plugin's `dependencies` resolve in.
  dependencyMarketplaces: string[];
  manifest: Manifest;
}

export interface SourceSpec {
  repo: string;
  pack?: string;
}

// `web-tool-routing` | `owner/repo` | `owner/repo/pack`
export function parseSpec(spec: string | undefined): SourceSpec {
  if (!spec) return { repo: DEFAULT_REPO };
  const [first, second, third, ...rest] = spec.split("/");
  if (!first || rest.length > 0) {
    throw new UsageError(`Cannot parse "${spec}"; use <pack>, <owner>/<repo>, or <owner>/<repo>/<pack>`);
  }
  if (second === undefined) return { repo: DEFAULT_REPO, pack: first };
  const repo = `${first}/${second}`;
  return third === undefined ? { repo } : { repo, pack: third };
}

// Shallow-clones a GitHub repo with the machine's own git credentials; returns the checkout dir and branch.
export function cloneRepo(repo: string): { dir: string; ref: string } {
  const dir = mkdtempSync(join(tmpdir(), "skillpack-"));
  execFileSync("git", ["clone", "--quiet", "--depth", "1", `https://github.com/${repo}.git`, dir], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  const ref = execFileSync("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
  return { dir, ref };
}

export const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

// Marketplace entries with a local source, as paths relative to the repo root (`plugins/stash`).
export const localPluginPaths = (marketplace: z.infer<typeof MarketplaceJson>): string[] =>
  marketplace.plugins.flatMap((entry) =>
    typeof entry.source === "string" ? [entry.source.replace(/^\.\//, "")] : [],
  );

// Skill folder names under a plugin: every `skills/<name>/` holding a SKILL.md.
export function listSkills(pluginRoot: string): string[] {
  const skillsDir = join(pluginRoot, "skills");
  return existsSync(skillsDir)
    ? readdirSync(skillsDir).filter((name) => existsSync(join(skillsDir, name, "SKILL.md")))
    : [];
}

// Every plugin in the repo's marketplace that ships a `skillpack.json`.
export function loadPacks(dir: string, repo: string, ref: string): Pack[] {
  const marketplace = MarketplaceJson.parse(readJson(join(dir, ".claude-plugin/marketplace.json")));
  return localPluginPaths(marketplace).flatMap((path): Pack[] => {
    const root = join(dir, path);
    if (!existsSync(join(root, "skillpack.json"))) return [];

    const plugin = PluginJson.parse(readJson(join(root, ".claude-plugin/plugin.json")));
    const manifest = Manifest.safeParse(readJson(join(root, "skillpack.json")));
    if (!manifest.success) {
      throw new UsageError(`${repo}: ${path}/skillpack.json is invalid:\n${z.prettifyError(manifest.error)}`);
    }
    const dependencyMarketplaces = plugin.dependencies.flatMap((dep) => {
      const market = typeof dep === "string" ? dep.split("@")[1] : dep.marketplace;
      return market ? [market] : [];
    });

    return [
      {
        name: plugin.name,
        marketplace: marketplace.name,
        repo,
        ref,
        path,
        skills: listSkills(root),
        dependencyMarketplaces: [...new Set(dependencyMarketplaces)],
        manifest: manifest.data,
      },
    ];
  });
}
