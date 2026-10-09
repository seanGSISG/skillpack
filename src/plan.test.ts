import { describe as group, expect, test } from "bun:test";
import { type Machine, planSteps, type Step } from "./plan.ts";
import type { Pack, Tool } from "./source.ts";

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
    npmTools: [],
    mcpServers: { "parallel-search": "https://search.parallel.ai/mcp" },
    claudeMarketplaces: { "parallel-agent-skills": "parallel-web/parallel-agent-skills" },
    skillSources: [{ source: "parallel-web/parallel-agent-skills", skills: ["parallel-deep-research"] }],
  },
};

const machine = (has: string[], overrides: Partial<Machine> = {}): Machine => ({
  has: (command) => has.includes(command),
  claudeMarketplaces: new Set(["claude-plugins-official"]),
  claudePlugins: new Set(),
  mcpServers: new Map(),
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
    expect(kinds(steps).slice(0, 2)).toEqual(["uv", "tool"]);
  });

  test("npm tools install with npm, need no uv, and get a sign-in check", () => {
    const octen = {
      package: "@octen.ai/cli",
      command: "octen",
      auth: ["octen", "whoami", "--json"],
      login: ["octen", "login"],
      apiKey: { login: ["octen", "login", "--api-key"], url: "https://octen.ai/platform/api-keys" },
    } satisfies Tool;
    const npmPack: Pack = { ...pack, manifest: { ...pack.manifest, uv: false, uvTools: [], npmTools: [octen] } };
    const steps = planSteps({ packs: [npmPack], agents: ["claude-code"], copy: false }, machine([]));
    expect(steps[0]).toEqual({ kind: "tool", manager: "npm", tool: octen });
    expect(kinds(steps)).not.toContain("uv");
    expect(steps.at(-1)).toEqual({ kind: "login", command: "octen", auth: octen.auth, login: octen.login, apiKey: octen.apiKey });
  });

  test("--copy reaches every skills step", () => {
    const steps = planSteps({ packs: [pack], agents: ["codex"], copy: true }, machine(["uv", "tvly"]));
    expect(steps.filter((step) => step.kind === "skills").every((step) => step.copy)).toBe(true);
  });

  test("MCP servers already configured are not rewritten", () => {
    const steps = planSteps(
      { packs: [pack], agents: ["codex"], copy: false },
      machine(["uv", "tvly"], { mcpServers: new Map([["codex", new Set(["parallel-search"])]]) }),
    );
    expect(steps.some((step) => step.kind === "mcp")).toBe(false);
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
