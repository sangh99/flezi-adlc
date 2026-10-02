# Structure

Terms in **bold** are defined in [`GLOSSARY.md`](../../GLOSSARY.md).

## `src/`: the engine

The directory is flat: one module per concern, each with its tests beside it. Files group by role as follows.

| Role                     | Modules                                                                                                                                                               |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public API               | `index.ts` (the export list), `run.ts`, `interactive.ts`, `createSandbox.ts`, `createWorktree.ts`, `Output.ts`                                                        |
| CLI and `init`           | `main.ts` (bin), `cli.ts` (`@effect/cli` commands), `InitService.ts`, `templates.ts` plus `templates/` (scaffolds, shipped into `dist/`)                              |
| Iteration loop           | `Orchestrator.ts` (iterations, timeouts, **completion signal**), `extractStructuredOutput.ts`, `AgentStreamEmitter.ts`, `TextDeltaBuffer.ts`                          |
| Prompts                  | `PromptResolver.ts`, `PromptArgumentSubstitution.ts`, `PromptPreprocessor.ts` (**prompt expansion**)                                                                  |
| Agents and sessions      | `AgentProvider.ts` (every built-in **agent provider**), `SessionStore.ts`, `resumePrecheck.ts`                                                                        |
| Sandbox contract         | `SandboxProvider.ts` (provider-author types), `SandboxFactory.ts` (Effect wrapper), `startSandbox.ts`, `SandboxLifecycle.ts` (**hooks**), `sandboxExec.ts`            |
| Built-in providers       | `sandboxes/{docker,podman,remote-docker,no-sandbox}.ts`, backed by `DockerLifecycle.ts`, `PodmanLifecycle.ts` and `mountUtils.ts`                                     |
| Git and sync             | `WorktreeManager.ts` (**worktrees**), `CopyToWorktree.ts`, `syncIn.ts` / `syncOut.ts` (**isolated sandbox providers**), `RecoveryMessage.ts`                          |
| Environment and plumbing | `EnvResolver.ts`, `mergeProviderEnv.ts`, `resolveCwd.ts`, `errors.ts`, `ErrorHandler.ts`, `Display.ts`, `shutdownRegistry.ts`, `terminalCleanup.ts`, `boundedTail.ts` |
| Test seams               | `testSetup.ts`, `testSandbox.ts`, `sandboxes/test-*.ts`                                                                                                               |

## Repo root

- `AGENTS.md` is the only agent instructions file; CI rejects any `CLAUDE.md`. `GLOSSARY.md` is the glossary.
- `docs/adr/`: decision records, numbered. Two kit ADRs cover the kit itself: 0021 (skills) and 0022 (Beads).
- `docs/agents/`: how the skills operate on this repo: `issue-tracker.md` (Beads commands, gate labels), `factory.md` (running the factory), `triage.md`, `domain.md`, plus the guides for adding an agent provider or an issue tracker.
- `docs/steering/`: these files. `docs/` is also a Fumadocs site, and its pages live in `docs/content/docs/`.
- `.changeset/`: pending release notes (rules in `AGENTS.md`).
- `.out-of-scope/`: features that were declined, with the reasons. Check it before proposing new built-ins.
- `research/`, `ideas/`, `plans/`, `docs/research/`: background notes. Not authoritative.

## Agent-facing directories

- **`.agents/skills/`** holds the skills, discovered by every agent that reads `.agents/`. `.claude/skills` is a committed symlink to it for Claude Code. Every skill here came from `mattpocock/skills`, and the pristine copies live on the `vendor/skills` branch. Main carries the kit's in-place edits, and upstream updates arrive by merging `vendor/skills` ([ADR-0021](../adr/0021-kit-owns-its-copies-of-matt-skills.md)). Give a skill the kit writes from scratch its own directory. `skills-lock.json` is informational only.
- **`.claude/rules/`** holds Claude Code path-scoped rules. Each is a Markdown file whose `paths:` front matter lists globs, and it loads when Claude reads a matching file ([docs](https://code.claude.com/docs/en/memory#path-specific-rules)). Other agents ignore this directory, so put guidance that every agent needs in `AGENTS.md` or a doc it links to. Current rules:
  - `vendored-skills.md` covers `.agents/skills/**`.
  - `sandboxed-prompts.md` covers `.sandcastle/**`.
- **`.claude/settings.json`** holds the shared Claude Code permissions. `settings.local.json` and `worktrees/` are gitignored, and everything else under `.claude/` is committed.
- **`.beads/`** holds the Beads config for specs and tasks ([ADR-0022](../adr/0022-beads-holds-specs-and-tasks.md)). The Dolt database itself is gitignored and lives on one host. Only `bd` touches it, and only on the host.

## Factory and dogfooding

- **`.sandcastle/`** is this repo's own **config directory**: the `Dockerfile` the sandbox image is built from, `CODING_STANDARDS.md`, the `test-*.ts` smoke scripts, `agent-workflows/` (the scripts behind `.github/workflows/agent-*.yml`) and `factory/`. It is distinct from the **workflows** defined in `GLOSSARY.md`.
- **`.sandcastle/factory/`** is the **factory**, started by `npm run factory` ([`docs/agents/factory.md`](../agents/factory.md)). `factory.ts` holds the run. `main.ts` wires in the production adapters: `beads-tracker.ts` for the `Tracker` port (`tracker.ts`), `code-host.ts` for `git push` and `gh`, and `host-git.ts` for merges on the host. The `*-prompt.md` files are the sandboxed agents' prompts, and `test-doubles.ts` backs `factory.test.ts`. Its own `tsconfig.json` is covered by `npm run typecheck`.
