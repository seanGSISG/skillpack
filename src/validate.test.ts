import { beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { validateMarketplace } from "./validate.ts";

let dir: string;

const write = (path: string, content: unknown) => {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), typeof content === "string" ? content : JSON.stringify(content));
};
const skill = (plugin: string, name: string, frontmatter = `name: ${name}\ndescription: Does ${name} things.`) =>
  write(`plugins/${plugin}/skills/${name}/SKILL.md`, `---\n${frontmatter}\n---\n\n# ${name}\n`);
const plugin = (name: string, version = "0.1.0", manifest: unknown = { uv: false }) => {
  write(`plugins/${name}/.claude-plugin/plugin.json`, { name, version });
  write(`plugins/${name}/skillpack.json`, manifest);
};
const git = (...args: string[]) =>
  execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" }).trim();
const commit = () => {
  git("add", "-A");
  git("commit", "-q", "-m", "change");
  return git("rev-parse", "HEAD");
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "skillpack-validate-"));
  write(".claude-plugin/marketplace.json", {
    name: "test",
    plugins: [
      { name: "alpha", source: "./plugins/alpha" },
      { name: "beta", source: "./plugins/beta" },
    ],
  });
  plugin("alpha");
  plugin("beta");
  skill("alpha", "alpha-one");
  skill("beta", "beta-one");
});

test("a clean marketplace passes", () => {
  expect(validateMarketplace(dir)).toEqual({ problems: [], plugins: 2, skills: 2 });
});

test("an unknown skillpack.json key is an error, not silently dropped", () => {
  plugin("alpha", "0.1.0", { uv: false, npmTools: [{ package: "x", command: "x", apikey: {} }] });
  const [problem] = validateMarketplace(dir).problems;
  expect(problem).toContain("plugins/alpha/skillpack.json");
  expect(problem).toContain("apikey");
});

test("skill names are global, match their folder, and carry a description", () => {
  skill("beta", "alpha-one");
  skill("beta", "renamed", "name: something-else\ndescription: x");
  skill("beta", "bare", "name: bare");
  expect(validateMarketplace(dir).problems).toEqual([
    'plugins/beta/skills/alpha-one/SKILL.md: skill name "alpha-one" is also used by plugins/alpha; names are global',
    "plugins/beta/skills/bare/SKILL.md: frontmatter needs a description",
    'plugins/beta/skills/renamed/SKILL.md: frontmatter name must be "renamed" (the folder name)',
  ]);
});

test("--since requires a version bump for every changed plugin except README-only changes", () => {
  git("init", "-q");
  const base = commit();
  skill("alpha", "alpha-two");
  write("plugins/beta/README.md", "docs only");
  commit();
  expect(validateMarketplace(dir, base).problems).toEqual([
    `plugins/alpha: changed since ${base.slice(0, 7)} but version is still 0.1.0; bump it`,
  ]);
  write("plugins/alpha/.claude-plugin/plugin.json", { name: "alpha", version: "0.1.1" });
  commit();
  expect(validateMarketplace(dir, base).problems).toEqual([]);
});
