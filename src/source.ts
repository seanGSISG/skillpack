import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export const DEFAULT_REPO = "seanGSISG/cc-plugins";

// A mistake in what the user asked for; the CLI prints the message without a stack trace.
export class UsageError extends Error {}

// `skillpack.json`, next to a plugin's `.claude-plugin/plugin.json`: what the pack needs beyond its skills.
const Manifest = z.object({
  uv: z.boolean().default(false),
  uvTools: z
    .array(
      z.object({
        package: z.string(),
        command: z.string(),
        auth: z.array(z.string()).nonempty().optional(),
        login: z.array(z.string()).nonempty().optional(),
      }),
    )
    .default([]),
  // Remote MCP servers for non-Claude agents; Claude Code gets them through plugin dependencies.
  mcpServers: z.record(z.string(), z.url()).default({}),
  // Marketplace name -> GitHub repo, for marketplaces the plugin's dependencies live in.
  claudeMarketplaces: z.record(z.string(), z.string()).default({}),
  // Skills from other repos that non-Claude agents need (Claude Code gets them as plugin dependencies).
  skillSources: z.array(z.object({ source: z.string(), skills: z.array(z.string()).nonempty() })).default([]),
});
export type Manifest = z.infer<typeof Manifest>;
export type UvTool = Manifest["uvTools"][number];

const PluginJson = z.object({
  name: z.string(),
  dependencies: z
    .array(z.union([z.string(), z.object({ name: z.string(), marketplace: z.string().optional() })]))
    .default([]),
});

const MarketplaceJson = z.object({
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

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

// Every plugin in the repo's marketplace that ships a `skillpack.json`.
export function loadPacks(dir: string, repo: string, ref: string): Pack[] {
  const marketplace = MarketplaceJson.parse(readJson(join(dir, ".claude-plugin/marketplace.json")));
  return marketplace.plugins.flatMap((entry): Pack[] => {
    if (typeof entry.source !== "string") return [];
    const path = entry.source.replace(/^\.\//, "");
    const root = join(dir, path);
    if (!existsSync(join(root, "skillpack.json"))) return [];

    const plugin = PluginJson.parse(readJson(join(root, ".claude-plugin/plugin.json")));
    const skillsDir = join(root, "skills");
    const skills = existsSync(skillsDir)
      ? readdirSync(skillsDir).filter((name) => existsSync(join(skillsDir, name, "SKILL.md")))
      : [];
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
        skills,
        dependencyMarketplaces: [...new Set(dependencyMarketplaces)],
        manifest: Manifest.parse(readJson(join(root, "skillpack.json"))),
      },
    ];
  });
}
