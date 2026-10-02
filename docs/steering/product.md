# Product

Terms in **bold** are defined in [`GLOSSARY.md`](../../GLOSSARY.md); use them as written there.

## Sandcastle

`@ai-hero/sandcastle` is a TypeScript library plus a `sandcastle` CLI. A caller hands `run()` an **agent provider**, a **sandbox provider** and a **prompt**. Sandcastle runs the **agent** inside the **sandbox** under a **branch strategy** and brings the commits back to the **host**. `createSandbox()` and `createWorktree()` split that lifecycle up for multi-step pipelines (for example implement, then review on the same branch). `sandcastle init` scaffolds a **config directory** from one of the templates in `src/templates/`.

Users are developers scripting AFK agents: parallel implementers, review pipelines, or a single loop over an **issue tracker**. The user-facing contract is the README, so check it whenever public behaviour changes (`AGENTS.md` says so too).

This repo is a fork of `mattpocock/sandcastle`. Engine changes made here so far: a `remoteDocker()` **isolated sandbox provider**, removal of the Vercel and Daytona providers, and Beads plus Claude Code as the `init` defaults. The pending entries in `.changeset/` list what has changed since the last release.

## The ADLC kit

The fork packages Sandcastle as the engine of the **ADLC kit**. On top of the engine, the kit adds:

- **Skills** in `.agents/skills/`: Matt Pocock's skills, edited in place for Beads and **approval gates** ([ADR-0021](../adr/0021-kit-owns-its-copies-of-matt-skills.md)).
- **Beads** as the single planning system: a **spec** is an epic, its **tasks** are children, and blocking edges are Beads dependencies. GitHub holds only code and PRs ([ADR-0022](../adr/0022-beads-holds-specs-and-tasks.md)).
- **Approval gates**: the spec, task and diagnosis gates are Beads labels a person applies; the merge gate is a PR review. The commands are in [`docs/agents/issue-tracker.md`](../agents/issue-tracker.md).
- **The factory**: an unattended runner that takes approved tasks, implements each in a sandbox and opens a PR. It runs only the implementation phase.
- **Workflows**: Feature, Quick and Bugfix, each ending at the merge gate.

## Principles

- **Humans own the gates.** Agents draft specs, tasks and fixes; a person passes every gate. Agents never approve, merge to main, or change task state.
- **The host owns the tracker.** Every `bd` call runs on the host. A sandboxed agent gets its task as prompt arguments and returns commits.
- **Curated built-ins, open extension points.** The built-in agent and sandbox providers are a deliberate shortlist. New runtimes plug in through `createBindMountSandboxProvider` / `createIsolatedSandboxProvider` or a custom `AgentProvider`. Before you propose a feature, check `.out-of-scope/` for a recorded "no".
- **Fail fast, with the fix in the message.** Errors are tagged and name the recovery (for example a missing `init` flag, or a failed prompt expansion as in ADR-0020).
- **Correctness over compatibility.** The package is pre-1.0. Breaking changes are allowed and ship as `minor` changesets.
- **Decisions live in ADRs.** Before changing behaviour in an area, read the `docs/adr/` records that cover it. If your change contradicts one, say so explicitly.
