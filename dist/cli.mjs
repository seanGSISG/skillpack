#!/usr/bin/env node

// src/cli.ts
import * as p2 from "@clack/prompts";
import { rmSync } from "node:fs";
import { parseArgs } from "node:util";

// src/agents.ts
import { agents as mcpAgents } from "add-mcp";

// src/system.ts
import spawn from "cross-spawn";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
var isWindows = process.platform === "win32";
function which(command) {
  const exts = isWindows ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    for (const ext of exts) {
      const candidate = join(dir, command + ext);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {}
    }
  }
  return;
}
function run(argv, { inherit = false } = {}) {
  const [command, ...args] = argv;
  if (!command)
    throw new Error("run: empty argv");
  return new Promise((resolve) => {
    const child = spawn(which(command) ?? command, args, { stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => stdout += chunk);
    child.stderr?.on("data", (chunk) => stderr += chunk);
    child.on("error", (error) => resolve({ ok: false, stdout, stderr: error.message }));
    child.on("close", (code) => resolve({ ok: code === 0, stdout, stderr }));
  });
}
async function runJson(argv) {
  try {
    return JSON.parse((await run(argv)).stdout);
  } catch {
    return;
  }
}
function prependPath(dir) {
  if (!(process.env.PATH ?? "").split(delimiter).includes(dir)) {
    process.env.PATH = `${dir}${delimiter}${process.env.PATH ?? ""}`;
  }
}
var UV_INSTALL = isWindows ? ["powershell", "-ExecutionPolicy", "ByPass", "-c", "irm https://astral.sh/uv/install.ps1 | iex"] : ["sh", "-c", "curl -LsSf https://astral.sh/uv/install.sh | sh"];
var UV_DEFAULT_BIN = join(homedir(), ".local", "bin");
var npmGlobalBin = (prefix) => isWindows ? prefix : join(prefix, "bin");

// src/agents.ts
var AGENTS = {
  "claude-code": { label: "Claude Code", mcp: "claude-code" },
  codex: { label: "Codex", mcp: "codex" },
  pi: { label: "Pi", mcp: "pi" },
  cursor: { label: "Cursor", mcp: "cursor" },
  opencode: { label: "OpenCode", mcp: "opencode" },
  "gemini-cli": { label: "Gemini CLI", mcp: "gemini-cli" },
  "github-copilot": { label: "GitHub Copilot CLI", mcp: "github-copilot-cli" },
  windsurf: { label: "Windsurf", mcp: "windsurf" },
  goose: { label: "Goose", mcp: "goose" },
  amp: { label: "Amp", mcp: null, bin: "amp" }
};
var isAgentId = (id) => Object.hasOwn(AGENTS, id);
var AGENT_IDS = Object.keys(AGENTS).filter(isAgentId);
async function detectAgents() {
  const found = await Promise.all(AGENT_IDS.map(async (id) => {
    const agent = AGENTS[id];
    const installed = agent.mcp ? await mcpAgents[agent.mcp].detectGlobalInstall().catch(() => false) : agent.bin !== undefined && which(agent.bin) !== undefined;
    return installed ? id : undefined;
  }));
  return found.filter((id) => id !== undefined);
}

// src/plan.ts
var uniqueBy = (items, key) => [
  ...new Map(items.map((item) => [key(item), item])).values()
];
var installedPacks = (packs, machine) => packs.filter((pack) => machine.claudePlugins.has(`${pack.name}@${pack.marketplace}`) || pack.skills.some((skill) => machine.agentSkills.has(skill)));
function planSteps({ packs, agents, copy }, machine) {
  const steps = [];
  const claude = agents.includes("claude-code");
  const others = agents.filter((id) => id !== "claude-code");
  const toolsFor = (manager) => uniqueBy(packs.flatMap((pack) => manager === "uv" ? pack.manifest.uvTools : pack.manifest.npmTools), (tool) => tool.package).map((tool) => ({ manager, tool }));
  const tools = [...toolsFor("uv"), ...toolsFor("npm")];
  const needsUv = packs.some((pack) => pack.manifest.uv) || tools.some(({ manager }) => manager === "uv");
  if (needsUv && !machine.has("uv"))
    steps.push({ kind: "uv" });
  for (const { manager, tool } of tools) {
    steps.push({ kind: "tool", action: machine.has(tool.command) ? "upgrade" : "install", manager, tool });
  }
  if (claude) {
    const marketplaces = uniqueBy(packs.flatMap((pack) => [
      { name: pack.marketplace, repo: pack.repo },
      ...pack.dependencyMarketplaces.flatMap((name) => {
        const repo = pack.manifest.claudeMarketplaces[name];
        return repo ? [{ name, repo }] : [];
      })
    ]), (market) => market.name);
    for (const market of marketplaces) {
      const action = machine.claudeMarketplaces.has(market.name) ? "update" : "add";
      steps.push({ kind: "claude-marketplace", action, ...market });
    }
    for (const pack of packs) {
      const id = `${pack.name}@${pack.marketplace}`;
      steps.push({ kind: "claude-plugin", action: machine.claudePlugins.has(id) ? "update" : "install", id });
    }
  }
  if (others.length > 0) {
    for (const pack of packs) {
      steps.push({
        kind: "skills",
        source: `https://github.com/${pack.repo}/tree/${pack.ref}/${pack.path}`,
        skills: pack.skills,
        agents: others,
        copy
      });
    }
    const sources = uniqueBy(packs.flatMap((pack) => pack.manifest.skillSources), (source) => source.source);
    for (const { source, skills } of sources) {
      steps.push({ kind: "skills", source, skills, agents: others, copy });
    }
    const servers = uniqueBy(packs.flatMap((pack) => Object.entries(pack.manifest.mcpServers)), ([name]) => name);
    for (const id of others) {
      const agent = AGENTS[id].mcp;
      for (const [name, url] of servers) {
        if (!agent)
          steps.push({ kind: "mcp-manual", agent: id, name, url });
        else if (!machine.mcpServers.get(agent)?.has(name))
          steps.push({ kind: "mcp", agent, name, url });
      }
    }
  }
  for (const { tool } of tools) {
    const { command, auth, login, apiKey } = tool;
    if (auth && login)
      steps.push({ kind: "login", command, auth, login, ...apiKey && { apiKey } });
  }
  return steps;
}
function describe(step) {
  switch (step.kind) {
    case "uv":
      return "Install uv";
    case "tool": {
      const { action, manager, tool } = step;
      if (manager === "uv")
        return `${action === "install" ? "Install" : "Upgrade"} ${tool.command} (uv tool ${action} ${tool.package})`;
      return action === "install" ? `Install ${tool.command} (npm install -g ${tool.package})` : `Upgrade ${tool.command} (npm install -g ${tool.package}@latest)`;
    }
    case "claude-marketplace":
      return step.action === "add" ? `Add Claude marketplace ${step.name} (${step.repo})` : `Refresh Claude marketplace ${step.name}`;
    case "claude-plugin":
      return `${step.action === "install" ? "Install" : "Update"} Claude plugin ${step.id}`;
    case "skills": {
      const mode = step.copy ? "copy" : "symlink";
      return `Install ${step.skills.length} skills from ${step.source} → ${step.agents.join(", ")} (${mode})`;
    }
    case "mcp":
      return `Add MCP server ${step.name} → ${step.agent}`;
    case "mcp-manual":
      return `Add MCP server ${step.name} (${step.url}) to ${AGENTS[step.agent].label} by hand`;
    case "login":
      return `Check ${step.command} sign-in`;
  }
}

// src/run.ts
import * as p from "@clack/prompts";
import { agents as mcpAgents2, listInstalledServers, upsertServer } from "add-mcp";
import { copyFileSync, existsSync, readdirSync } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { join as join2 } from "node:path";
var SKILLS_CLI = "skills@1";
var lastLine = (text) => text.trim().split(`
`).at(-1) ?? "";
async function probeMachine(agents) {
  const hasClaude = which("claude") !== undefined;
  const names = async (argv, key) => {
    const rows = hasClaude ? await runJson(argv) : undefined;
    if (!Array.isArray(rows))
      return new Set;
    return new Set(rows.flatMap((row) => typeof row[key] === "string" && row.enabled !== false ? [row[key]] : []));
  };
  const mcpAgentIds = agents.flatMap((id) => AGENTS[id].mcp ?? []).filter((id) => id !== "claude-code");
  const [claudeMarketplaces, claudePlugins, installed] = await Promise.all([
    names(["claude", "plugin", "marketplace", "list", "--json"], "name"),
    names(["claude", "plugin", "list", "--json"], "id"),
    mcpAgentIds.length ? listInstalledServers({ global: true, agents: mcpAgentIds }) : []
  ]);
  const mcpServers = new Map(installed.map((agent) => [agent.agentType, new Set(agent.servers.map((server) => server.serverName))]));
  const skillsDir = join2(homedir2(), ".agents", "skills");
  const agentSkills = new Set(existsSync(skillsDir) ? readdirSync(skillsDir) : []);
  return { has: (command) => which(command) !== undefined, claudeMarketplaces, claudePlugins, agentSkills, mcpServers };
}
async function isSignedIn(auth) {
  const result = await run(auth);
  try {
    const status = JSON.parse(result.stdout);
    if (typeof status === "object" && status !== null && "authenticated" in status) {
      return status.authenticated === true;
    }
  } catch {}
  return result.ok;
}
function signInOptions(step, overSsh) {
  const browser = { value: "browser", label: `Browser sign-in (${step.login.join(" ")})` };
  const later = { value: "later", label: "Later" };
  if (!step.apiKey)
    return [{ ...browser, hint: "recommended" }, later];
  const key = { value: "key", label: "Paste an API key" };
  return overSsh ? [{ ...key, hint: "recommended over SSH" }, browser, later] : [{ ...browser, hint: "recommended" }, key, later];
}
async function signIn(step, interactive) {
  if (await isSignedIn(step.auth))
    return { status: "skipped", detail: "already signed in" };
  const browser = step.login.join(" ");
  const later = step.apiKey ? `${browser} (or ${step.apiKey.login.join(" ")} <key>)` : browser;
  if (!interactive)
    return { status: "manual", detail: `run: ${later}` };
  const overSsh = Boolean(process.env.SSH_CONNECTION || process.env.SSH_TTY);
  const method = await p.select({
    message: `${step.command} is not signed in. Sign in now?`,
    options: signInOptions(step, overSsh)
  });
  if (p.isCancel(method) || method === "later")
    return { status: "manual", detail: `run later: ${later}` };
  if (method === "browser") {
    await run(step.login, { inherit: true });
    if (await isSignedIn(step.auth))
      return { status: "done" };
    if (step.apiKey)
      p.log.warn("Browser sign-in did not finish. Paste an API key instead, or press Esc to skip.");
  }
  if (!step.apiKey)
    return { status: "failed", detail: `still not signed in; run: ${browser}` };
  const { login, url } = step.apiKey;
  const key = await p.password({
    message: `${step.command} API key${url ? ` (create one at ${url})` : ""}`,
    validate: (value) => value?.trim() ? undefined : "Paste a key, or press Esc to skip"
  });
  if (p.isCancel(key))
    return { status: "manual", detail: `run later: ${later}` };
  const result = await run([...login, key.trim()]);
  if (await isSignedIn(step.auth))
    return { status: "done" };
  return { status: "failed", detail: lastLine(result.stderr || result.stdout) || "key not accepted" };
}
async function runStep(step, interactive) {
  switch (step.kind) {
    case "uv": {
      await run(UV_INSTALL, { inherit: true });
      prependPath(UV_DEFAULT_BIN);
      return which("uv") ? { status: "done" } : { status: "failed", detail: "uv not found after install" };
    }
    case "tool": {
      const { action, manager, tool } = step;
      const uv = manager === "uv";
      const result = await run(uv ? ["uv", "tool", action, tool.package] : ["npm", "install", "-g", action === "upgrade" ? `${tool.package}@latest` : tool.package]);
      if (!result.ok) {
        if (uv && action === "upgrade" && result.stderr.includes("is not installed")) {
          return { status: "skipped", detail: "not installed with uv; left as is" };
        }
        return { status: "failed", detail: lastLine(result.stderr) };
      }
      if (action === "upgrade")
        return { status: "done" };
      prependPath(uv ? (await run(["uv", "tool", "dir", "--bin"])).stdout.trim() : npmGlobalBin((await run(["npm", "prefix", "-g"])).stdout.trim()));
      if (which(tool.command))
        return { status: "done" };
      const fix = uv ? "run: uv tool update-shell" : "add npm's global bin (npm prefix -g) to PATH";
      return { status: "failed", detail: `installed, but not on PATH; ${fix}` };
    }
    case "claude-marketplace": {
      const target = step.action === "add" ? step.repo : step.name;
      const result = await run(["claude", "plugin", "marketplace", step.action, target]);
      return result.ok ? { status: "done" } : { status: "failed", detail: lastLine(result.stderr) };
    }
    case "claude-plugin": {
      const result = await run(["claude", "plugin", step.action, step.id]);
      if (!result.ok)
        return { status: "failed", detail: lastLine(result.stderr || result.stdout) };
      return step.action === "update" ? { status: "done", detail: lastLine(result.stdout).replace(/^\W+/, "") } : { status: "done" };
    }
    case "skills": {
      const result = await run([
        "npx",
        "-y",
        SKILLS_CLI,
        "add",
        step.source,
        "-g",
        ...step.agents.flatMap((agent) => ["-a", agent]),
        ...step.skills.flatMap((skill) => ["-s", skill]),
        "-y",
        ...step.copy ? ["--copy"] : []
      ]);
      return result.ok ? { status: "done" } : { status: "failed", detail: lastLine(result.stderr || result.stdout) };
    }
    case "mcp": {
      const configPath = mcpAgents2[step.agent].configPath;
      const backup = `${configPath}.skillpack-backup`;
      if (existsSync(configPath) && !existsSync(backup))
        copyFileSync(configPath, backup);
      const result = upsertServer(step.agent, step.name, { type: "http", url: step.url });
      if (!result.success)
        return { status: "failed", detail: result.error ?? result.path };
      return { status: "done", detail: existsSync(backup) ? `${result.path} (original: ${backup})` : result.path };
    }
    case "mcp-manual":
      return { status: "manual", detail: `add ${step.url} as "${step.name}"` };
    case "login":
      return signIn(step, interactive);
  }
}
function progress(label) {
  if (!process.stdout.isTTY)
    return { done: (message) => p.log.success(message), fail: (message) => p.log.error(message) };
  const spin = p.spinner();
  spin.start(label);
  return { done: (message) => spin.stop(message), fail: (message) => spin.error(message) };
}
var usesTerminal = (step) => step.kind === "uv" || step.kind === "login";
async function execute(steps, { interactive }) {
  const outcomes = [];
  for (const step of steps) {
    const label = describe(step);
    const terminal = usesTerminal(step);
    const shown = terminal ? undefined : progress(label);
    if (terminal)
      p.log.step(label);
    const outcome = await runStep(step, interactive);
    const message = outcome.detail ? `${label} — ${outcome.detail}` : label;
    if (shown && outcome.status === "failed")
      shown.fail(message);
    else if (shown)
      shown.done(message);
    else if (outcome.status === "failed")
      p.log.error(message);
    else if (outcome.detail)
      p.log.info(outcome.detail);
    outcomes.push({ step, ...outcome });
  }
  return outcomes;
}

// src/source.ts
import { execFileSync } from "node:child_process";
import { existsSync as existsSync2, mkdtempSync, readdirSync as readdirSync2, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as join3 } from "node:path";
import { z } from "zod";
var DEFAULT_REPO = "seanGSISG/cc-plugins";

class UsageError extends Error {
}
var Tool = z.strictObject({
  package: z.string(),
  command: z.string(),
  auth: z.array(z.string()).nonempty().optional(),
  login: z.array(z.string()).nonempty().optional(),
  apiKey: z.strictObject({ login: z.array(z.string()).nonempty(), url: z.url().optional() }).optional()
});
var Manifest = z.strictObject({
  uv: z.boolean().default(false),
  uvTools: z.array(Tool).default([]),
  npmTools: z.array(Tool).default([]),
  mcpServers: z.record(z.string(), z.url()).default({}),
  claudeMarketplaces: z.record(z.string(), z.string()).default({}),
  skillSources: z.array(z.strictObject({ source: z.string(), skills: z.array(z.string()).nonempty() })).default([])
});
var PluginJson = z.object({
  name: z.string(),
  version: z.string().optional(),
  dependencies: z.array(z.union([z.string(), z.object({ name: z.string(), marketplace: z.string().optional() })])).default([])
});
var MarketplaceJson = z.object({
  name: z.string(),
  plugins: z.array(z.object({ name: z.string(), source: z.unknown() }))
});
function parseSpec(spec) {
  if (!spec)
    return { repo: DEFAULT_REPO };
  const [first, second, third, ...rest] = spec.split("/");
  if (!first || rest.length > 0) {
    throw new UsageError(`Cannot parse "${spec}"; use <pack>, <owner>/<repo>, or <owner>/<repo>/<pack>`);
  }
  if (second === undefined)
    return { repo: DEFAULT_REPO, pack: first };
  const repo = `${first}/${second}`;
  return third === undefined ? { repo } : { repo, pack: third };
}
function cloneRepo(repo) {
  const dir = mkdtempSync(join3(tmpdir(), "skillpack-"));
  execFileSync("git", ["clone", "--quiet", "--depth", "1", `https://github.com/${repo}.git`, dir], {
    stdio: ["ignore", "ignore", "pipe"]
  });
  const ref = execFileSync("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
  return { dir, ref };
}
var readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
var localPluginPaths = (marketplace) => marketplace.plugins.flatMap((entry) => typeof entry.source === "string" ? [entry.source.replace(/^\.\//, "")] : []);
function listSkills(pluginRoot) {
  const skillsDir = join3(pluginRoot, "skills");
  return existsSync2(skillsDir) ? readdirSync2(skillsDir).filter((name) => existsSync2(join3(skillsDir, name, "SKILL.md"))).sort() : [];
}
function loadPacks(dir, repo, ref) {
  const marketplace = MarketplaceJson.parse(readJson(join3(dir, ".claude-plugin/marketplace.json")));
  return localPluginPaths(marketplace).flatMap((path) => {
    const root = join3(dir, path);
    if (!existsSync2(join3(root, "skillpack.json")))
      return [];
    const plugin = PluginJson.parse(readJson(join3(root, ".claude-plugin/plugin.json")));
    const manifest = Manifest.safeParse(readJson(join3(root, "skillpack.json")));
    if (!manifest.success) {
      throw new UsageError(`${repo}: ${path}/skillpack.json is invalid:
${z.prettifyError(manifest.error)}`);
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
        manifest: manifest.data
      }
    ];
  });
}

// src/validate.ts
import { execFileSync as execFileSync2 } from "node:child_process";
import { existsSync as existsSync3, readFileSync as readFileSync2 } from "node:fs";
import { join as join4 } from "node:path";
import { z as z2 } from "zod";
function frontmatter(markdown) {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown)?.[1] ?? "";
  return new Map(block.split(/\r?\n/).flatMap((line) => {
    const [, key, value = ""] = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line) ?? [];
    return key ? [[key, value.trim().replace(/^["']|["']$/g, "")]] : [];
  }));
}
function isNewer(version, than) {
  const a = version.split(".").map(Number);
  const b = than.split(".").map(Number);
  for (let i = 0;i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0)
      return diff > 0;
  }
  return false;
}
var git = (dir, args) => execFileSync2("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
function versionAt(dir, rev, path) {
  try {
    return PluginJson.parse(JSON.parse(git(dir, ["show", `${rev}:./${path}/.claude-plugin/plugin.json`]))).version;
  } catch {
    return;
  }
}
function validateMarketplace(dir, since) {
  const problems = [];
  const marketplace = MarketplaceJson.safeParse(readJson(join4(dir, ".claude-plugin/marketplace.json")));
  if (!marketplace.success) {
    return { problems: [`.claude-plugin/marketplace.json: ${z2.prettifyError(marketplace.error)}`], plugins: 0, skills: 0 };
  }
  const paths = localPluginPaths(marketplace.data);
  const owners = new Map;
  for (const path of paths) {
    const root = join4(dir, path);
    if (existsSync3(join4(root, "skillpack.json"))) {
      const manifest = Manifest.safeParse(readJson(join4(root, "skillpack.json")));
      if (!manifest.success)
        problems.push(`${path}/skillpack.json: ${z2.prettifyError(manifest.error)}`);
    }
    for (const skill of listSkills(root)) {
      const meta = frontmatter(readFileSync2(join4(root, "skills", skill, "SKILL.md"), "utf8"));
      const where = `${path}/skills/${skill}/SKILL.md`;
      if (meta.get("name") !== skill)
        problems.push(`${where}: frontmatter name must be "${skill}" (the folder name)`);
      if (!meta.get("description"))
        problems.push(`${where}: frontmatter needs a description`);
      const owner = owners.get(skill);
      if (owner)
        problems.push(`${where}: skill name "${skill}" is also used by ${owner}; names are global`);
      else
        owners.set(skill, path);
    }
  }
  if (since) {
    const changed = git(dir, ["diff", "--name-only", "--relative", since, "HEAD"]).split(`
`).filter(Boolean);
    for (const path of paths) {
      const touched = changed.some((file) => file.startsWith(`${path}/`) && file !== `${path}/README.md`);
      const before = versionAt(dir, since, path);
      if (!touched || before === undefined)
        continue;
      const after = versionAt(dir, "HEAD", path);
      if (after === undefined || !isNewer(after, before)) {
        problems.push(`${path}: changed since ${since.slice(0, 7)} but version is still ${after ?? "missing"}; bump it`);
      }
    }
  }
  return { problems, plugins: paths.length, skills: owners.size };
}

// src/cli.ts
var HELP = `skillpack — install skill packs (skills, CLIs, MCP servers, Claude plugin) into coding agents

Usage:
  skillpack [add] [<pack> | <owner>/<repo> | <owner>/<repo>/<pack>]
      Install packs, or bring them up to date when already installed. With no pack, lists the packs in
      ${DEFAULT_REPO} (or the given repo) to choose from.
  skillpack update [<pack> | <owner>/<repo>]
      Bring every pack installed on this machine up to date (or just the named one).
  skillpack validate [<dir>] [--since <ref>]
      Check a local marketplace checkout: manifests, skill names, and (with --since) version bumps.

Options:
  -a, --agent <id>   Install for this agent (repeatable): ${AGENT_IDS.join(", ")}
  -y, --yes          No prompts: detected agents, symlinks, everything; logins are left to you
      --copy         Copy skills into each agent instead of symlinking to ~/.agents/skills
      --dry-run      Print the steps without running them
      --since <ref>  validate: require a version bump in every plugin changed since <ref>
  -h, --help         Show this help`;
var COMMANDS = ["add", "update", "validate"];
var isCommand = (word) => COMMANDS.some((command) => command === word);
function unwrap(value) {
  if (p2.isCancel(value)) {
    p2.cancel("Cancelled.");
    process.exit(130);
  }
  return value;
}
async function choosePacks(available, wanted, yes) {
  if (wanted) {
    const pack = available.find((candidate) => candidate.name === wanted);
    if (!pack)
      throw new UsageError(`No pack "${wanted}"; available: ${available.map((x) => x.name).join(", ")}`);
    return [pack];
  }
  if (available.length === 0)
    throw new UsageError("This repo has no plugins with a skillpack.json.");
  if (available.length === 1)
    return available;
  if (yes)
    throw new UsageError("Name a pack when using --yes.");
  const names = unwrap(await p2.multiselect({
    message: "Which packs?",
    options: available.map((pack) => ({ value: pack.name, label: pack.name })),
    required: true
  }));
  return available.filter((pack) => names.includes(pack.name));
}
async function chooseAgents(flagged, yes) {
  if (flagged?.length) {
    const unknown = flagged.filter((id) => !isAgentId(id));
    if (unknown.length)
      throw new UsageError(`Unknown agent: ${unknown.join(", ")}`);
    return flagged.filter(isAgentId);
  }
  const detected = await detectAgents();
  if (yes) {
    if (detected.length === 0)
      throw new UsageError("No agents detected; pass --agent.");
    return detected;
  }
  return unwrap(await p2.multiselect({
    message: "Install for which agents? (detected ones are checked)",
    options: AGENT_IDS.map((id) => {
      const hint = id === "claude-code" ? "as a plugin" : detected.includes(id) ? "detected" : undefined;
      return { value: id, label: AGENTS[id].label, ...hint && { hint } };
    }),
    initialValues: detected,
    required: true
  }));
}
async function chooseCopy(agents, flag, yes) {
  if (flag !== undefined)
    return flag;
  if (yes || agents.every((id) => id === "claude-code"))
    return false;
  const mode = unwrap(await p2.select({
    message: "How should skills be installed for the non-Claude agents?",
    options: [
      { value: "symlink", label: "Global, symlinked", hint: "one copy in ~/.agents/skills; recommended" },
      { value: "copy", label: "Global, copied", hint: "independent copy per agent" }
    ]
  }));
  return mode === "copy";
}
function validate(dir, since) {
  const { problems, plugins, skills } = validateMarketplace(dir, since);
  for (const problem of problems)
    console.error(`✗ ${problem}`);
  if (problems.length)
    return 1;
  console.log(`✓ ${plugins} plugins, ${skills} skills${since ? `, versions bumped since ${since.slice(0, 7)}` : ""}`);
  return 0;
}
async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      agent: { type: "string", short: "a", multiple: true },
      yes: { type: "boolean", short: "y", default: false },
      copy: { type: "boolean" },
      "dry-run": { type: "boolean", default: false },
      since: { type: "string" },
      help: { type: "boolean", short: "h", default: false }
    }
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  const [first, ...rest] = positionals;
  const command = isCommand(first) ? first : "add";
  const args = isCommand(first) ? rest : positionals;
  if (args.length > 1)
    throw new UsageError(`Unexpected arguments: ${args.slice(1).join(" ")}`);
  if (command === "validate")
    return validate(args[0] ?? ".", values.since);
  const spec = parseSpec(args[0]);
  const yes = values.yes;
  p2.intro("skillpack");
  const fetching = progress(`Fetching ${spec.repo}`);
  let checkout;
  try {
    checkout = cloneRepo(spec.repo);
  } catch {
    fetching.fail(`Could not clone ${spec.repo}; check that git can reach it (private repos need git or gh auth).`);
    return 1;
  }
  let packs;
  try {
    packs = loadPacks(checkout.dir, spec.repo, checkout.ref);
  } finally {
    rmSync(checkout.dir, { recursive: true, force: true });
  }
  fetching.done(`Fetched ${spec.repo}`);
  let chosen;
  let agents;
  let machine;
  if (command === "update" && !spec.pack) {
    agents = await chooseAgents(values.agent, yes);
    machine = await probeMachine(agents);
    chosen = installedPacks(packs, machine);
    if (chosen.length === 0) {
      p2.outro(`No packs from ${spec.repo} are installed here.`);
      return 0;
    }
    p2.log.info(`Updating ${chosen.map((pack) => pack.name).join(", ")}`);
  } else {
    chosen = await choosePacks(packs, spec.pack, yes);
    agents = await chooseAgents(values.agent, yes);
    machine = await probeMachine(agents);
  }
  const copy = await chooseCopy(agents, values.copy, yes);
  const steps = planSteps({ packs: chosen, agents, copy }, machine);
  if (steps.length === 0) {
    p2.outro("Everything is already installed.");
    return 0;
  }
  p2.note(steps.map((step, i) => `${i + 1}. ${describe(step)}`).join(`
`), "Plan");
  if (values["dry-run"]) {
    p2.outro("Dry run; nothing changed.");
    return 0;
  }
  if (!yes && !unwrap(await p2.confirm({ message: "Run these steps?" }))) {
    p2.cancel("Nothing changed.");
    return 0;
  }
  const outcomes = await execute(steps, { interactive: !yes });
  const failed = outcomes.filter((outcome) => outcome.status === "failed");
  const manual = outcomes.filter((outcome) => outcome.status === "manual");
  const next = [
    ...manual.map((outcome) => `${describe(outcome.step)}: ${outcome.detail}`),
    ...outcomes.some((o) => o.step.kind === "claude-plugin" && o.status === "done") ? ["Claude Code: run /reload-plugins in open sessions."] : [],
    ...outcomes.some((o) => o.step.kind === "mcp" && o.status === "done") ? ["Restart the other agents so they load the new MCP servers."] : []
  ];
  if (next.length)
    p2.note(next.join(`
`), "Next");
  p2.outro(failed.length ? `${failed.length} step(s) failed; see above.` : "Done.");
  return failed.length ? 1 : 0;
}
main().then((code) => process.exit(code), (error) => {
  if (error instanceof UsageError) {
    p2.log.error(error.message);
    process.exit(2);
  }
  throw error;
});
