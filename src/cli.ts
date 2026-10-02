#!/usr/bin/env node
import * as p from "@clack/prompts";
import { rmSync } from "node:fs";
import { parseArgs } from "node:util";
import { AGENT_IDS, AGENTS, type AgentId, detectAgents, isAgentId } from "./agents.ts";
import { describe, planSteps } from "./plan.ts";
import { execute, probeMachine } from "./run.ts";
import { cloneRepo, DEFAULT_REPO, loadPacks, type Pack, parseSpec, UsageError } from "./source.ts";

const HELP = `skillpack — install skill packs (skills, CLIs, MCP servers, Claude plugin) into coding agents

Usage:
  skillpack [add] [<pack> | <owner>/<repo> | <owner>/<repo>/<pack>]

  With no pack, lists the packs in ${DEFAULT_REPO} (or the given repo) to choose from.

Options:
  -a, --agent <id>   Install for this agent (repeatable): ${AGENT_IDS.join(", ")}
  -y, --yes          No prompts: detected agents, symlinks, everything; logins are left to you
      --copy         Copy skills into each agent instead of symlinking to ~/.agents/skills
      --dry-run      Print the steps without running them
  -h, --help         Show this help`;

function unwrap<T>(value: T | typeof p.CANCEL_SYMBOL): T {
  if (p.isCancel(value)) {
    p.cancel("Cancelled.");
    process.exit(130);
  }
  return value;
}

async function choosePacks(available: Pack[], wanted: string | undefined, yes: boolean): Promise<Pack[]> {
  if (wanted) {
    const pack = available.find((candidate) => candidate.name === wanted);
    if (!pack) throw new UsageError(`No pack "${wanted}"; available: ${available.map((x) => x.name).join(", ")}`);
    return [pack];
  }
  if (available.length === 0) throw new UsageError("This repo has no plugins with a skillpack.json.");
  if (available.length === 1) return available;
  if (yes) throw new UsageError("Name a pack when using --yes.");
  const names = unwrap(
    await p.multiselect({
      message: "Which packs?",
      options: available.map((pack) => ({ value: pack.name, label: pack.name })),
      required: true,
    }),
  );
  return available.filter((pack) => names.includes(pack.name));
}

async function chooseAgents(flagged: string[] | undefined, yes: boolean): Promise<AgentId[]> {
  if (flagged?.length) {
    const unknown = flagged.filter((id) => !isAgentId(id));
    if (unknown.length) throw new UsageError(`Unknown agent: ${unknown.join(", ")}`);
    return flagged.filter(isAgentId);
  }
  const detected = await detectAgents();
  if (yes) {
    if (detected.length === 0) throw new UsageError("No agents detected; pass --agent.");
    return detected;
  }
  return unwrap(
    await p.multiselect({
      message: "Install for which agents? (detected ones are checked)",
      options: AGENT_IDS.map((id) => {
        const hint = id === "claude-code" ? "as a plugin" : detected.includes(id) ? "detected" : undefined;
        return { value: id, label: AGENTS[id].label, ...(hint && { hint }) };
      }),
      initialValues: detected,
      required: true,
    }),
  );
}

async function chooseCopy(agents: AgentId[], flag: boolean | undefined, yes: boolean): Promise<boolean> {
  if (flag !== undefined) return flag;
  if (yes || agents.every((id) => id === "claude-code")) return false;
  const mode = unwrap(
    await p.select({
      message: "How should skills be installed for the non-Claude agents?",
      options: [
        { value: "symlink", label: "Global, symlinked", hint: "one copy in ~/.agents/skills; recommended" },
        { value: "copy", label: "Global, copied", hint: "independent copy per agent" },
      ],
    }),
  );
  return mode === "copy";
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      agent: { type: "string", short: "a", multiple: true },
      yes: { type: "boolean", short: "y", default: false },
      copy: { type: "boolean" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  const args = positionals[0] === "add" ? positionals.slice(1) : positionals;
  if (args.length > 1) throw new UsageError(`Unexpected arguments: ${args.slice(1).join(" ")}`);
  const spec = parseSpec(args[0]);
  const yes = values.yes;

  p.intro("skillpack");

  const fetching = p.spinner();
  fetching.start(`Fetching ${spec.repo}`);
  let checkout: { dir: string; ref: string };
  try {
    checkout = cloneRepo(spec.repo);
  } catch {
    fetching.error(`Could not clone ${spec.repo}; check that git can reach it (private repos need git or gh auth).`);
    return 1;
  }
  let packs: Pack[];
  try {
    packs = loadPacks(checkout.dir, spec.repo, checkout.ref);
  } finally {
    rmSync(checkout.dir, { recursive: true, force: true });
  }
  fetching.stop(`Fetched ${spec.repo}`);

  const chosen = await choosePacks(packs, spec.pack, yes);
  const agents = await chooseAgents(values.agent, yes);
  const copy = await chooseCopy(agents, values.copy, yes);

  const steps = planSteps({ packs: chosen, agents, copy }, await probeMachine());
  if (steps.length === 0) {
    p.outro("Everything is already installed.");
    return 0;
  }
  p.note(steps.map((step, i) => `${i + 1}. ${describe(step)}`).join("\n"), "Plan");
  if (values["dry-run"]) {
    p.outro("Dry run; nothing changed.");
    return 0;
  }
  if (!yes && !unwrap(await p.confirm({ message: "Run these steps?" }))) {
    p.cancel("Nothing changed.");
    return 0;
  }

  const outcomes = await execute(steps, { interactive: !yes });

  const failed = outcomes.filter((outcome) => outcome.status === "failed");
  const manual = outcomes.filter((outcome) => outcome.status === "manual");
  const next = [
    ...manual.map((outcome) => `${describe(outcome.step)}: ${outcome.detail}`),
    ...(outcomes.some((o) => o.step.kind === "claude-plugin" && o.status === "done")
      ? ["Claude Code: run /reload-plugins in open sessions."]
      : []),
    ...(outcomes.some((o) => o.step.kind === "mcp" && o.status === "done")
      ? ["Restart the other agents so they load the new MCP servers."]
      : []),
  ];
  if (next.length) p.note(next.join("\n"), "Next");
  p.outro(failed.length ? `${failed.length} step(s) failed; see above.` : "Done.");
  return failed.length ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    if (error instanceof UsageError) {
      p.log.error(error.message);
      process.exit(2);
    }
    throw error;
  },
);
