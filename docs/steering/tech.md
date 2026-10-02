# Tech

Terms in **bold** are defined in [`CONTEXT.md`](../../CONTEXT.md).

## Stack

- TypeScript, ESM-only, Node 18 or later as the build target. npm is the package manager (`packageManager` is pinned in `package.json`).
- **Effect** (`effect`, `@effect/platform`, `@effect/cli`) runs the internals. `@clack/prompts` drives the `init` UI and is the only runtime dependency. Everything else is bundled.
- Bundled by `tsup` into the entry points listed in `tsup.config.ts`. Each entry maps to a `package.json#exports` subpath (`.`, `./sandboxes/docker`, and so on).
- Type-checked by `tsgo` (`@typescript/native-preview`). Tested with Vitest. Formatted with Prettier.

## Commands

The `package.json` scripts are the source of truth. Points that are easy to miss:

- `npm run typecheck` is the type check. CI does not run it (CI only builds and tests on pushes to `main`), so run it yourself.
- `npm run build` also copies `src/templates/` into `dist/` and runs `scripts/check-public-types-effect-free.mjs`. That script fails the build if any `.d.ts` references `effect`.
- `npm test` runs `src/**/*.test.ts`. These tests need git but no container runtime.
- `npm run factory`, `test-podman` and `test-interactive` run real agents in real containers. They need Docker or Podman plus `.sandcastle/.env`. The factory also needs `bd` and `gh` on the host ([`docs/agents/factory.md`](../agents/factory.md)).
- The pre-commit hook runs Prettier on staged files through `lint-staged`. Symlinks are skipped, and `.prettierignore` excludes `.agents/skills/` and `skills-lock.json`.
- CI fails if a `CLAUDE.md` or `CLAUDE.local.md` exists anywhere, because either one stops Claude Code from reading `AGENTS.md`.

## Effect usage

The full rules are in [`.sandcastle/CODING_STANDARDS.md`](../../.sandcastle/CODING_STANDARDS.md). Read it before writing code. In outline:

- **Effect inside, Promises outside.** Public functions are `async`, and each one delegates straight into a single `Effect.gen(...).pipe(Effect.runPromise)`. Effect types never appear in the public API, and the build check above enforces this.
- **Services are `Context.Tag`s** (`SandboxFactory`, `SandboxConfig`, `Display`, `AgentStreamEmitter`). To override behaviour in tests, provide a different layer rather than adding an `@internal` option.
- **Failures are tagged errors** from `src/errors.ts` (`Data.TaggedError`). `ErrorHandler.ts` turns them into user-facing messages.
- Sandbox providers expose a small Promise-based handle. `SandboxFactory.ts` wraps it into the Effect `SandboxService`.

## Conventions

- Changesets follow the rules in `AGENTS.md`. One commit may carry several changesets, one per user-facing behaviour.
- Public exports carry JSDoc.
- Container-side paths are POSIX (`posix.join`); host-side paths use the platform-aware `join`. Normalise separators before you compare paths, because git emits `/` even on Windows.
- Every interactive `init` prompt has a matching CLI flag, added in the same change.
- Each sandbox provider keeps its own integration code. Only pure, provider-agnostic utilities (such as `boundedTail.ts`) are shared.

## Testing

- Write integration-style tests through public interfaces, and mock only at system boundaries. TDD runs in vertical slices (one red-green cycle per test). Details are in `CODING_STANDARDS.md` and the `tdd` skill.
- Tests sit next to the module they cover (`Foo.ts` and `Foo.test.ts`). Most tests drive real git repos in temp directories.
- `src/testSetup.ts` gives every Vitest worker its own global gitconfig, so concurrent `git config --global` calls cannot race.
- Seams that stand in for a container: `src/testSandbox.ts` (a filesystem `SandboxService`), plus `src/sandboxes/test-bind-mount.ts` and `src/sandboxes/test-isolated.ts` (test providers for each provider kind).
- Windows path handling has dedicated `*-windowsMounts.test.ts` and `*.windowsPath.test.ts` files. Bugs that only appear with mixed separators stay hidden on Linux and macOS CI, so add a case there when you touch path code.

## Sandbox and agent providers

- Built-in sandbox providers live in `src/sandboxes/`: `docker` and `podman` (**bind-mount**), `remote-docker` (**isolated**, synced with `docker cp`) and `no-sandbox`.
- Built-in agent providers live in `src/AgentProvider.ts`: Claude Code, Codex, Cursor, OpenCode, Copilot and Pi.
- An `exec` with an `onLine` callback must stream lines in real time, because the idle timeout depends on it.
- To add an agent, follow [`docs/agents/adding-an-agent-provider.md`](../agents/adding-an-agent-provider.md). To add a tracker to `init`, follow [`docs/agents/adding-an-issue-tracker.md`](../agents/adding-an-issue-tracker.md).
