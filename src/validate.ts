import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { listSkills, localPluginPaths, Manifest, MarketplaceJson, PluginJson, readJson } from "./source.ts";

export interface Validation {
  problems: string[];
  plugins: number;
  skills: number;
}

// The frontmatter's top-level `key: value` pairs; enough to check `name` and `description` without a YAML parser.
function frontmatter(markdown: string): Map<string, string> {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown)?.[1] ?? "";
  return new Map(
    block.split(/\r?\n/).flatMap((line): [string, string][] => {
      const [, key, value = ""] = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line) ?? [];
      return key ? [[key, value.trim().replace(/^["']|["']$/g, "")]] : [];
    }),
  );
}

// "0.10.2" > "0.9.9", compared part by part as numbers.
function isNewer(version: string, than: string): boolean {
  const a = version.split(".").map(Number);
  const b = than.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

const git = (dir: string, args: string[]): string =>
  execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

// The plugin's version in a commit; undefined when the plugin did not exist there.
function versionAt(dir: string, rev: string, path: string): string | undefined {
  try {
    return PluginJson.parse(JSON.parse(git(dir, ["show", `${rev}:./${path}/.claude-plugin/plugin.json`]))).version;
  } catch {
    return undefined;
  }
}

// Checks a local marketplace checkout (what CI and the cc-plugins pre-push hook run): every skillpack.json
// parses, skill names are unique and match their folders, and, with `since`, every plugin changed between
// `since` and HEAD (beyond its README.md) has a higher version. Reads the working tree; versions come from git.
export function validateMarketplace(dir: string, since?: string): Validation {
  const problems: string[] = [];
  const marketplace = MarketplaceJson.safeParse(readJson(join(dir, ".claude-plugin/marketplace.json")));
  if (!marketplace.success) {
    return { problems: [`.claude-plugin/marketplace.json: ${z.prettifyError(marketplace.error)}`], plugins: 0, skills: 0 };
  }
  const paths = localPluginPaths(marketplace.data);
  const owners = new Map<string, string>();

  for (const path of paths) {
    const root = join(dir, path);
    if (existsSync(join(root, "skillpack.json"))) {
      const manifest = Manifest.safeParse(readJson(join(root, "skillpack.json")));
      if (!manifest.success) problems.push(`${path}/skillpack.json: ${z.prettifyError(manifest.error)}`);
    }
    for (const skill of listSkills(root)) {
      const meta = frontmatter(readFileSync(join(root, "skills", skill, "SKILL.md"), "utf8"));
      const where = `${path}/skills/${skill}/SKILL.md`;
      if (meta.get("name") !== skill) problems.push(`${where}: frontmatter name must be "${skill}" (the folder name)`);
      if (!meta.get("description")) problems.push(`${where}: frontmatter needs a description`);
      const owner = owners.get(skill);
      if (owner) problems.push(`${where}: skill name "${skill}" is also used by ${owner}; names are global`);
      else owners.set(skill, path);
    }
  }

  if (since) {
    const changed = git(dir, ["diff", "--name-only", "--relative", since, "HEAD"]).split("\n").filter(Boolean);
    for (const path of paths) {
      const touched = changed.some((file) => file.startsWith(`${path}/`) && file !== `${path}/README.md`);
      const before = versionAt(dir, since, path);
      if (!touched || before === undefined) continue;
      const after = versionAt(dir, "HEAD", path);
      if (after === undefined || !isNewer(after, before)) {
        problems.push(`${path}: changed since ${since.slice(0, 7)} but version is still ${after ?? "missing"}; bump it`);
      }
    }
  }
  return { problems, plugins: paths.length, skills: owners.size };
}
