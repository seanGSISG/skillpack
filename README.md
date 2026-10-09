# skillpack

Installs a **skill pack** into every coding agent on a machine: its skills, the CLIs they call, its MCP servers,
and sign-in. Claude Code gets the pack as a plugin; other agents get the skills in `~/.agents/skills` plus MCP config.

## Install

Needs Node, and `git` (or `gh`) signed in to GitHub, since the packs repo is private.

```sh
npx --allow-git=root github:seanGSISG/skillpack                       # pick packs from seanGSISG/cc-plugins
npx --allow-git=root github:seanGSISG/skillpack add web-tool-routing  # one pack
npx --allow-git=root github:seanGSISG/skillpack add owner/repo/pack   # a pack from another marketplace repo
```

`--allow-git=root` lets npm fetch skillpack itself from GitHub; npm 12 refuses git packages by default (`EALLOWGIT`).

The wizard asks which agents to install for and whether to symlink or copy, shows the plan, then installs uv and
the pack's CLIs, the Claude plugin, the skills and MCP servers for the other agents, and finally signs in each
CLI that isn't: browser sign-in (OAuth) first, or a pasted API key where the CLI takes one.

- `--agent <id>` (repeatable): `claude-code`, `codex`, `pi`, `cursor`, `opencode`, `gemini-cli`, `github-copilot`,
  `windsurf`, `goose`, `amp` (skills only).
- `--yes`: no prompts, detected agents, sign-ins left to you. `--copy`: copy skills instead of symlinking.
  `--dry-run`: print the plan only.

Re-running is safe: finished steps are skipped. Updates: `claude plugin update <pack>@cc-plugins` (Claude Code),
`npx skills update -g` (other agents).

## Packs and skills

| Pack | Skill | What it does |
|---|---|---|
| babysit | `babysit` | Takes a PR from opened to merged: reviews, fixes, a scripted merge gate |
| fastapi-best-practices | `fastapi` | The FastAPI team's own conventions (vendored official skill) |
| | `fastapi-app-patterns` | Settings, lifespan, database sessions, Entra ID/JWT auth, tests |
| go-best-practices | `go-best-practices` | Production Go: lifecycle, concurrency, config, testing, CI |
| pack-author | `pack-author` | Builds, registers and releases packs for skillpack and cc-plugins |
| stash | `stash` | Moves files between machines through a private R2 bucket; share links |
| web-tool-routing | `web-tool-routing` | Picks Octen, Parallel or Tavily for each web task |
| | `web-tool-setup` | Checks and installs the pack's CLIs and sign-ins |
| | `octen-search` | Web and news search, multi-angle surveys (default search) |
| | `octen-extract` | Reads URLs as markdown or query-focused highlights (default reader) |
| | `tavily-map`, `tavily-crawl` | Lists a site's URLs; crawls a site to markdown |
| | `tavily-search`, `tavily-extract`, `tavily-research`, `tavily-dynamic-search` | Tavily fallbacks for search, reading and research |
| | `tavily-cli`, `tavily-best-practices` | Tavily CLI setup; reference for Tavily integrations |

web-tool-routing also installs Parallel's `parallel-deep-research`, `parallel-findall`, `parallel-data-enrichment`,
`parallel-monitor` and `parallel-cli-setup` for non-Claude agents (Claude Code gets them from the Parallel plugin).

## Making a pack

A pack is a plugin in a Claude marketplace repo with a `skillpack.json` beside `.claude-plugin/plugin.json`; every
`skills/*/SKILL.md` is installed. The `pack-author` skill walks through it.

```json
{
  "uv": true,
  "uvTools": [{ "package": "tavily-cli", "command": "tvly", "auth": ["tvly", "auth", "--json"], "login": ["tvly", "login"] }],
  "npmTools": [{
    "package": "@octen.ai/cli", "command": "octen", "auth": ["octen", "whoami", "--json"], "login": ["octen", "login"],
    "apiKey": { "login": ["octen", "login", "--api-key"], "url": "https://octen.ai/platform/api-keys" }
  }],
  "mcpServers": { "parallel-search": "https://search.parallel.ai/mcp" },
  "claudeMarketplaces": { "parallel-agent-skills": "parallel-web/parallel-agent-skills" },
  "skillSources": [{ "source": "parallel-web/parallel-agent-skills", "skills": ["parallel-deep-research"] }]
}
```

- `uv`: install uv (set it when a script runs via `uv run`).
- `uvTools` / `npmTools`: CLIs installed with `uv tool install` / `npm install -g`. `auth` reports sign-in (JSON
  `authenticated: true`, or exit code 0); `login` is the browser sign-in; `apiKey.login` gets a pasted key appended.
- `mcpServers`, `skillSources`: for non-Claude agents; Claude Code gets both through the plugin's `dependencies`.
- `claudeMarketplaces`: repos for the marketplaces those `dependencies` live in.

## Development

```sh
bun install && bun test && bun run typecheck
bun run bundle   # writes dist/cli.mjs; commit it, since npx github: runs dist directly
node dist/cli.mjs add web-tool-routing --dry-run
```

`src/plan.ts` turns choices + manifest + machine state into steps; `src/run.ts` runs them. Keep `build`, `prepare`,
`prepack` and install hooks out of `package.json`: they make `npx github:` run an inner `npm install` that fails
silently on npm ≥ 11.17 when `allow-scripts` is set ([npm/cli#9783](https://github.com/npm/cli/issues/9783)).
