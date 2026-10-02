# The factory

The **factory** (`.sandcastle/factory/`) takes work that has passed its **approval gates** from Beads, builds each item in a Docker **sandbox**, runs the required checks itself and opens a pull request for the **merge gate**. One run is one pass over the backlog: it takes every eligible item, then exits with a report. It never merges to the base branch and never writes the host's checkout.

## Start it

```sh
npm run factory
```

Run it from the repo root on the **host**, with every prerequisite below in place. It exits 1 if any item it took failed, so a scheduler can notice.

## Prerequisites

- `bd` on the `PATH`, with this repo's Beads database. The factory does every `bd` read and write itself.
- `gh` authenticated for this repo, and push access to `origin`. The factory pushes branches and opens pull requests with them.
- The Docker image, built from `.sandcastle/Dockerfile`: `npm run build && node dist/main.js docker build-image`, run from the repo root. The default `docker()` sandbox uses the image `sandcastle:<repo directory name>`, so build and run from the same directory.
- Agent credentials in `.sandcastle/.env` (copy `.sandcastle/.env.example`). The default agent is Claude Code.

## Environment

`.sandcastle/factory/main.ts` lists the variables in its header comment and is the source of truth. Currently:

- `FACTORY_BASE_BRANCH`: the branch work is cut from and pull requests target. Default `main`.
- `FACTORY_PARALLEL`: how many items the factory builds at once. Default 4. Merges into one integration branch still happen one at a time.

## What it takes

It reads `bd ready` (unblocked, non-epic issues) and takes an item when its gate labels are in place:

| Workflow | Takes                           | Gate labels                                       |
| -------- | ------------------------------- | ------------------------------------------------- |
| Feature  | a `task` under a spec epic      | `spec-approved` and `ready-for-agent` on the spec |
| Quick    | a `task` with no parent         | `ready-for-agent` on the task                     |
| Bugfix   | a `bug`, with or without parent | `ready-for-agent` on the bug                      |

An item carrying `factory-failed` is skipped until a person removes that label. See [`issue-tracker.md`](issue-tracker.md) for the gates and how to pass them.

## What it produces

- **Quick and Bugfix**: branch `factory/<id>` cut from the base branch, one pull request per task or bug. The factory closes the issue once the PR is open.
- **Feature**: each task is built on `factory/<task-id>`, cut from the spec's integration branch `factory/<spec-id>`, and merged into it on the host; the factory then closes the task. Once every task of the spec is closed, a reviewer agent works over the integration branch and the factory opens one pull request for the whole spec, marking the spec `factory-pr-opened` so no later run opens a second. A spec whose tasks all closed but whose PR step failed or never ran gets it on a later run. At the start of each run, the factory closes any spec whose pull request has merged.

Work is accepted only if the agent reports done, made commits, and `npm run typecheck` and `npm test` pass in the sandbox. If a Feature task's merge into the integration branch conflicts, one merge agent tries to resolve it and the checks run again; a second failure fails the task.

While an item runs, the factory renews its Beads claim every minute (`bd heartbeat`), so a long agent run keeps it.

## Recover from a failure

When the factory gives up on an item, it comments the reason on the issue and adds `factory-failed`. It also releases its claim (`bd unclaim`), so the item is open again. Read the comment, fix the cause (edit the issue text, unblock it, resolve the conflict on the integration branch), then remove the label: `bd update <id> --remove-label factory-failed`. The next run takes it again, on a branch reset to its base, so nothing from the failed attempt carries over.
