import { describe as group, expect, test } from "bun:test";
import { type Machine, planSteps, type Step } from "./plan.ts";
import type { Pack } from "./source.ts";

const pack: Pack = {
  name: "web-tool-routing",
  marketplace: "cc-plugins",
  repo: "seanGSISG/cc-plugins",
  ref: "main",
  path: "plugins/web-tool-routing",
  skills: ["web-tool-routing", "tavily-crawl"],
  dependencyMarketplaces: ["claude-plugins-official", "parallel-agent-skills"],
  manifest: {
    uv: true,
    uvTools: [
      { package: "tavily-cli", command: "tvly", auth: ["tvly", "auth", "--json"], login: ["tvly", "login"] },
    ],
    mcpServers: { "parallel-search": "https://search.parallel.ai/mcp" },
    claudeMarketplaces: { "parallel-agent-skills": "parallel-web/parallel-agent-skills" },
    skillSources: [{ source: "parallel-web/parallel-agent-skills", skills: ["parallel-deep-research"] }],
  },
};

const machine = (has: string[], overrides: Partial<Machine> = {}): Machine => ({
  has: (command) => has.includes(command),
  claudeMarketplaces: new Set(["claude-plugins-official"]),
  claudePlugins: new Set(),
  ...overrides,
});

const kinds = (steps: Step[]) => steps.map((step) => step.kind);

group("planSteps", () => {
  test("Claude only: plugin route, no skills or MCP steps", () => {
    const steps = planSteps({ packs: [pack], agents: ["claude-code"], copy: false }, machine(["uv", "tvly"]));
    expect(steps).toEqual([
      { kind: "claude-marketplace", name: "cc-plugins", repo: "seanGSISG/cc-plugins" },
      { kind: "claude-marketplace", name: "parallel-agent-skills", repo: "parallel-web/parallel-agent-skills" },
      { kind: "claude-plugin", id: "web-tool-routing@cc-plugins" },
      { kind: "login", command: "tvly", auth: ["tvly", "auth", "--json"], login: ["tvly", "login"] },
    ]);
  });

  test("Claude + codex + pi: skills and MCP go to the non-Claude agents only", () => {
    const steps = planSteps(
      { packs: [pack], agents: ["claude-code", "codex", "pi"], copy: false },
      machine(["uv", "tvly"], {
        claudeMarketplaces: new Set(["cc-plugins", "claude-plugins-official", "parallel-agent-skills"]),
        claudePlugins: new Set(["web-tool-routing@cc-plugins"]),
      }),
    );
    expect(kinds(steps)).toEqual(["skills", "skills", "mcp", "mcp", "login"]);
    expect(steps[0]).toEqual({
      kind: "skills",
      source: "https://github.com/seanGSISG/cc-plugins/tree/main/plugins/web-tool-routing",
      skills: ["web-tool-routing", "tavily-crawl"],
      agents: ["codex", "pi"],
      copy: false,
    });
    expect(steps.filter((step) => step.kind === "mcp").map((step) => step.agent)).toEqual(["codex", "pi"]);
  });

  test("missing uv and CLI are installed first", () => {
    const steps = planSteps({ packs: [pack], agents: ["codex"], copy: false }, machine([]));
    expect(kinds(steps).slice(0, 2)).toEqual(["uv", "uv-tool"]);
  });

  test("--copy reaches every skills step", () => {
    const steps = planSteps({ packs: [pack], agents: ["codex"], copy: true }, machine(["uv", "tvly"]));
    expect(steps.filter((step) => step.kind === "skills").every((step) => step.copy)).toBe(true);
  });

  test("agent without an add-mcp id gets a manual MCP step", () => {
    const steps = planSteps({ packs: [pack], agents: ["amp"], copy: false }, machine(["uv", "tvly"]));
    expect(steps).toContainEqual({
      kind: "mcp-manual",
      agent: "amp",
      name: "parallel-search",
      url: "https://search.parallel.ai/mcp",
    });
  });
});
