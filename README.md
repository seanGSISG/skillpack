# skillpack

One command that installs a **skill pack** into every coding agent on a machine: the skills, the CLIs they call,
the MCP servers they expect, and sign-in. Claude Code gets the pack as its native plugin; every other agent gets
symlinked skills plus MCP config.

```sh
npx github:seanGSISG/skillpack                      # choose packs from seanGSISG/cc-plugins
npx github:seanGSISG/skillpack add web-tool-routing
npx github:seanGSISG/skillpack add owner/repo/pack  # any Claude marketplace repo with skillpack.json
```

Private repo: the machine's `git` (or `gh`) must be signed in to GitHub.

## What the wizard does

1. Clones the marketplace repo and finds plugins that ship a `skillpack.json`.
2. Asks which agents to install for (detected ones pre-checked) and whether to symlink or copy.
3. Installs **uv** if missing, then each CLI with `uv tool install`.
4. **Claude Code**: adds the marketplaces and runs `claude plugin install <pack>@<marketplace>`; the plugin's
   `dependencies` bring its MCP servers and skills.
5. **Other agents**: `npx skills add <pack url> -g` (one canonical copy in `~/.agents/skills`, symlinked into each
   agent), the pack's `skillSources`, and each MCP server via [add-mcp](https://add-mcp.com).
6. Checks each CLI's sign-in and offers to run its login.

Options: `--agent <id>` (repeatable), `--yes` (detected agents, symlinks, no prompts, logins left to you), `--copy`,
`--dry-run`. Agents: `claude-code`, `codex`, `pi`, `cursor`, `opencode`, `gemini-cli`, `github-copilot`, `windsurf`,
`goose`, `amp` (Amp gets skills only; its MCP servers are listed for you to add).

Re-running is safe: steps already satisfied are skipped. An already-installed Claude plugin is not upgraded; use
`claude plugin update <pack>@<marketplace>`. Skills update with `npx skills update -g`.

## Pack manifest

A pack is a Claude Code plugin directory with a `skillpack.json` beside `.claude-plugin/plugin.json`. Every
`skills/*/SKILL.md` is installed. Skill names share `~/.agents/skills` with every other pack, so make them specific.

```json
{
  "uv": true,
  "uvTools": [
    { "package": "tavily-cli", "command": "tvly", "auth": ["tvly", "auth", "--json"], "login": ["tvly", "login"] }
  ],
  "mcpServers": { "exa": "https://mcp.exa.ai/mcp" },
  "claudeMarketplaces": { "parallel-agent-skills": "parallel-web/parallel-agent-skills" },
  "skillSources": [{ "source": "parallel-web/parallel-agent-skills", "skills": ["parallel-deep-research"] }]
}
```

| Field | Used for |
|---|---|
| `uv`, `uvTools` | Install uv and these tools everywhere. `auth` must print JSON with `authenticated: true` when signed in. |
| `mcpServers` | Remote MCP servers written into non-Claude agents (Claude gets them from plugin `dependencies`). |
| `claudeMarketplaces` | Repos for the marketplaces the plugin's `dependencies` live in, added if missing. |
| `skillSources` | Skills from other repos that non-Claude agents need (Claude gets them from plugin `dependencies`). |

## Development

```sh
bun install
bun test            # planner tests
bun run typecheck
bun run build       # writes dist/cli.mjs; commit it, since npx github: runs dist directly
node dist/cli.mjs add web-tool-routing --dry-run
```

`src/plan.ts` is the core: choices + manifest + machine state → ordered steps. `src/run.ts` executes them.
