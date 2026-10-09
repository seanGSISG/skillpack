# skillpack

CLI that installs a cc-plugins **pack** (skills, CLIs, MCP servers, sign-in) into every coding agent. Users run it as `npx --allow-git=root github:seanGSISG/skillpack`, which executes the committed `dist/cli.mjs`, never `src/`.

## Every change

- After editing `src/`: `bun test && bun run typecheck && bun run bundle`, and commit `dist/cli.mjs` in the same commit.
- Verify a pushed change against a pinned commit, since npx caches `github:` installs: `npx --allow-git=root -y github:seanGSISG/skillpack#<sha> add <pack> --dry-run --yes`.
- Keep `package.json` scripts free of `build`, `prepare`, `prepack` and install hooks: any of them makes `npx github:` run an inner `npm install` that fails silently ([npm/cli#9783](https://github.com/npm/cli/issues/9783)).
- Spawn child processes with `run()` in `src/system.ts` (cross-spawn on the resolved path). It keeps Windows `.cmd` shims working and passes `|`, `&` and `%` in arguments through literally.

## Manifest fields

`skillpack.json` is parsed by the zod schema in `src/source.ts`. A new field lands in one change across `src/source.ts`, `src/plan.ts` and `src/plan.test.ts`, `src/run.ts`, the README's "Making a pack" section, and rule 3 of the `pack-author` skill in cc-plugins.

The README's "Packs and skills" table is a static copy of cc-plugins: update it whenever a pack gains, loses, or renames a skill.
