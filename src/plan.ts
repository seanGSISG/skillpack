import type { AgentType } from "add-mcp";
import { AGENTS, type AgentId } from "./agents.ts";
import type { Pack, Tool } from "./source.ts";

export type ToolManager = "uv" | "npm";

export type Step =
  | { kind: "uv" }
  | { kind: "tool"; action: "install" | "upgrade"; manager: ToolManager; tool: Tool }
  | { kind: "claude-marketplace"; action: "add" | "update"; name: string; repo: string }
  | { kind: "claude-plugin"; action: "install" | "update"; id: string }
  | { kind: "skills"; source: string; skills: string[]; agents: AgentId[]; copy: boolean }
  | { kind: "mcp"; agent: AgentType; name: string; url: string }
  | { kind: "mcp-manual"; agent: AgentId; name: string; url: string }
  | { kind: "login"; command: string; auth: string[]; login: string[]; apiKey?: NonNullable<Tool["apiKey"]> };

// What is already on the machine, probed once before planning.
export interface Machine {
  has: (command: string) => boolean;
  claudeMarketplaces: ReadonlySet<string>;
  claudePlugins: ReadonlySet<string>;
  // Skill folder names in ~/.agents/skills, where `npx skills` installs for non-Claude agents.
  agentSkills: ReadonlySet<string>;
  // MCP server names already in each add-mcp agent's global config; those are never rewritten.
  mcpServers: ReadonlyMap<AgentType, ReadonlySet<string>>;
}

export interface Choices {
  packs: Pack[];
  agents: AgentId[];
  // Copy skills into each agent instead of symlinking to ~/.agents/skills.
  copy: boolean;
}

const uniqueBy = <T>(items: T[], key: (item: T) => string): T[] => [
  ...new Map(items.map((item) => [key(item), item])).values(),
];

// Packs already on this machine: the Claude plugin is installed, or any of its skills is in ~/.agents/skills.
export const installedPacks = (packs: Pack[], machine: Machine): Pack[] =>
  packs.filter(
    (pack) =>
      machine.claudePlugins.has(`${pack.name}@${pack.marketplace}`) ||
      pack.skills.some((skill) => machine.agentSkills.has(skill)),
  );

// Turns the wizard's choices into ordered steps: installs what is missing and brings what is already
// there up to date, so re-running is how a machine gets updates.
export function planSteps({ packs, agents, copy }: Choices, machine: Machine): Step[] {
  const steps: Step[] = [];
  const claude = agents.includes("claude-code");
  const others = agents.filter((id) => id !== "claude-code");

  const toolsFor = (manager: ToolManager) =>
    uniqueBy(
      packs.flatMap((pack) => (manager === "uv" ? pack.manifest.uvTools : pack.manifest.npmTools)),
      (tool) => tool.package,
    ).map((tool) => ({ manager, tool }));
  const tools = [...toolsFor("uv"), ...toolsFor("npm")];
  const needsUv = packs.some((pack) => pack.manifest.uv) || tools.some(({ manager }) => manager === "uv");
  if (needsUv && !machine.has("uv")) steps.push({ kind: "uv" });
  for (const { manager, tool } of tools) {
    steps.push({ kind: "tool", action: machine.has(tool.command) ? "upgrade" : "install", manager, tool });
  }

  if (claude) {
    const marketplaces = uniqueBy(
      packs.flatMap((pack) => [
        { name: pack.marketplace, repo: pack.repo },
        ...pack.dependencyMarketplaces.flatMap((name) => {
          const repo = pack.manifest.claudeMarketplaces[name];
          return repo ? [{ name, repo }] : [];
        }),
      ]),
      (market) => market.name,
    );
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
        copy,
      });
    }
    const sources = uniqueBy(
      packs.flatMap((pack) => pack.manifest.skillSources),
      (source) => source.source,
    );
    for (const { source, skills } of sources) {
      steps.push({ kind: "skills", source, skills, agents: others, copy });
    }

    const servers = uniqueBy(
      packs.flatMap((pack) => Object.entries(pack.manifest.mcpServers)),
      ([name]) => name,
    );
    for (const id of others) {
      const agent = AGENTS[id].mcp;
      for (const [name, url] of servers) {
        if (!agent) steps.push({ kind: "mcp-manual", agent: id, name, url });
        else if (!machine.mcpServers.get(agent)?.has(name)) steps.push({ kind: "mcp", agent, name, url });
      }
    }
  }

  for (const { tool } of tools) {
    const { command, auth, login, apiKey } = tool;
    if (auth && login) steps.push({ kind: "login", command, auth, login, ...(apiKey && { apiKey }) });
  }
  return steps;
}

export function describe(step: Step): string {
  switch (step.kind) {
    case "uv":
      return "Install uv";
    case "tool": {
      const { action, manager, tool } = step;
      if (manager === "uv") return `${action === "install" ? "Install" : "Upgrade"} ${tool.command} (uv tool ${action} ${tool.package})`;
      return action === "install"
        ? `Install ${tool.command} (npm install -g ${tool.package})`
        : `Upgrade ${tool.command} (npm install -g ${tool.package}@latest)`;
    }
    case "claude-marketplace":
      return step.action === "add"
        ? `Add Claude marketplace ${step.name} (${step.repo})`
        : `Refresh Claude marketplace ${step.name}`;
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
