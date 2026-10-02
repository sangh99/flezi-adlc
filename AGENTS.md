Use `npm run typecheck` for type checking.

Check [./CONTEXT.md](./CONTEXT.md) for terminology questions.

For user-facing changes, add a changeset to `.changeset`. Check all changesets there first to see if there are duplicates. We use `@changesets/cli`, but you can create/edit the file manually. Make all bugfixes `patch`, all new features or breaking changes `minor` (since we're pre-1.0). Use `package.json#name` for the name.

When changing public-facing behavior, check `README.md` to see if the documentation needs updating.

## Steering

- [`docs/steering/product.md`](docs/steering/product.md): read it before you decide scope, add a feature or built-in, or touch the ADLC kit's gates and factory.
- [`docs/steering/tech.md`](docs/steering/tech.md): read it before you write or test code. It covers the Effect conventions, the commands and the test seams.
- [`docs/steering/structure.md`](docs/steering/structure.md): read it when you need to find where something lives or decide where a new file goes.

## Agent skills

### Issue tracker

Issues and specs live in Beads (`bd` CLI, run on the host only). Pull requests stay on GitHub and are not a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical labels. Agent provider support is detailed here. See `docs/agents/triage.md`.

### Domain docs

Single-context layout: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
