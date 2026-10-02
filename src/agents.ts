import { agents as mcpAgents, type AgentType } from "add-mcp";
import { which } from "./system.ts";

interface AgentDef {
  label: string;
  // add-mcp agent id; null when add-mcp cannot configure this agent.
  mcp: AgentType | null;
  // Detection fallback when there is no add-mcp id.
  bin?: string;
}

// Agents the wizard offers, keyed by `npx skills` agent id: ones both `npx skills` and add-mcp
// can configure, plus Amp (skills only).
export const AGENTS = {
  "claude-code": { label: "Claude Code", mcp: "claude-code" },
  codex: { label: "Codex", mcp: "codex" },
  pi: { label: "Pi", mcp: "pi" },
  cursor: { label: "Cursor", mcp: "cursor" },
  opencode: { label: "OpenCode", mcp: "opencode" },
  "gemini-cli": { label: "Gemini CLI", mcp: "gemini-cli" },
  "github-copilot": { label: "GitHub Copilot CLI", mcp: "github-copilot-cli" },
  windsurf: { label: "Windsurf", mcp: "windsurf" },
  goose: { label: "Goose", mcp: "goose" },
  amp: { label: "Amp", mcp: null, bin: "amp" },
} as const satisfies Record<string, AgentDef>;

export type AgentId = keyof typeof AGENTS;

export const isAgentId = (id: string): id is AgentId => Object.hasOwn(AGENTS, id);

export const AGENT_IDS = Object.keys(AGENTS).filter(isAgentId);

// Ids of the agents installed on this machine.
export async function detectAgents(): Promise<AgentId[]> {
  const found = await Promise.all(
    AGENT_IDS.map(async (id) => {
      const agent: AgentDef = AGENTS[id];
      const installed = agent.mcp
        ? await mcpAgents[agent.mcp].detectGlobalInstall().catch(() => false)
        : agent.bin !== undefined && which(agent.bin) !== undefined;
      return installed ? id : undefined;
    }),
  );
  return found.filter((id) => id !== undefined);
}
