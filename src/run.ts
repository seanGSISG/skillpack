import * as p from "@clack/prompts";
import { upsertServer } from "add-mcp";
import { describe, type Machine, type Step } from "./plan.ts";
import { prependPath, run, runJson, UV_DEFAULT_BIN, UV_INSTALL, which } from "./system.ts";

export type Status = "done" | "skipped" | "failed" | "manual";

export interface Outcome {
  step: Step;
  status: Status;
  detail?: string;
}

// Pinned to a major so a breaking `skills` release can't change our flags underneath us.
const SKILLS_CLI = "skills@1";

const lastLine = (text: string): string => text.trim().split("\n").at(-1) ?? "";

// Reads the machine state planSteps() needs.
export async function probeMachine(): Promise<Machine> {
  const hasClaude = which("claude") !== undefined;
  const names = async (argv: string[], key: "name" | "id"): Promise<Set<string>> => {
    const rows = hasClaude ? await runJson(argv) : undefined;
    if (!Array.isArray(rows)) return new Set();
    return new Set(
      rows.flatMap((row: Record<string, unknown>) =>
        typeof row[key] === "string" && row.enabled !== false ? [row[key]] : [],
      ),
    );
  };
  const [claudeMarketplaces, claudePlugins] = await Promise.all([
    names(["claude", "plugin", "marketplace", "list", "--json"], "name"),
    names(["claude", "plugin", "list", "--json"], "id"),
  ]);
  return { has: (command) => which(command) !== undefined, claudeMarketplaces, claudePlugins };
}

async function isSignedIn(auth: string[]): Promise<boolean> {
  const status = await runJson(auth);
  return typeof status === "object" && status !== null && "authenticated" in status && status.authenticated === true;
}

async function runStep(step: Step, interactive: boolean): Promise<Omit<Outcome, "step">> {
  switch (step.kind) {
    case "uv": {
      await run(UV_INSTALL, { inherit: true });
      prependPath(UV_DEFAULT_BIN);
      return which("uv") ? { status: "done" } : { status: "failed", detail: "uv not found after install" };
    }
    case "uv-tool": {
      const result = await run(["uv", "tool", "install", step.tool.package]);
      if (!result.ok) return { status: "failed", detail: lastLine(result.stderr) };
      prependPath((await run(["uv", "tool", "dir", "--bin"])).stdout.trim());
      return which(step.tool.command)
        ? { status: "done" }
        : { status: "failed", detail: "installed, but not on PATH; run: uv tool update-shell" };
    }
    case "claude-marketplace": {
      const result = await run(["claude", "plugin", "marketplace", "add", step.repo]);
      return result.ok ? { status: "done" } : { status: "failed", detail: lastLine(result.stderr) };
    }
    case "claude-plugin": {
      const result = await run(["claude", "plugin", "install", step.id]);
      return result.ok ? { status: "done" } : { status: "failed", detail: lastLine(result.stderr || result.stdout) };
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
        ...(step.copy ? ["--copy"] : []),
      ]);
      return result.ok ? { status: "done" } : { status: "failed", detail: lastLine(result.stderr || result.stdout) };
    }
    case "mcp": {
      const result = upsertServer(step.agent, step.name, { type: "http", url: step.url });
      return result.success
        ? { status: "done", detail: result.path }
        : { status: "failed", detail: result.error ?? result.path };
    }
    case "mcp-manual":
      return { status: "manual", detail: `add ${step.url} as "${step.name}"` };
    case "login": {
      if (await isSignedIn(step.auth)) return { status: "skipped", detail: "already signed in" };
      const command = step.login.join(" ");
      if (!interactive) return { status: "manual", detail: `run: ${command}` };
      const answer = await p.confirm({ message: `${step.command} is not signed in. Run \`${command}\` now?` });
      if (p.isCancel(answer) || !answer) return { status: "manual", detail: `run later: ${command}` };
      await run(step.login, { inherit: true });
      return (await isSignedIn(step.auth)) ? { status: "done" } : { status: "failed", detail: `still not signed in; run: ${command}` };
    }
  }
}

// Steps that hand the terminal to a child process can't sit under a spinner.
const usesTerminal = (step: Step): boolean => step.kind === "uv" || step.kind === "login";

export async function execute(steps: Step[], { interactive }: { interactive: boolean }): Promise<Outcome[]> {
  const outcomes: Outcome[] = [];
  for (const step of steps) {
    const label = describe(step);
    if (usesTerminal(step)) {
      p.log.step(label);
      outcomes.push({ step, ...(await runStep(step, interactive)) });
      continue;
    }
    const spin = p.spinner();
    spin.start(label);
    const outcome = await runStep(step, interactive);
    const message = outcome.detail ? `${label} — ${outcome.detail}` : label;
    if (outcome.status === "failed") spin.error(message);
    else spin.stop(message);
    outcomes.push({ step, ...outcome });
  }
  return outcomes;
}
