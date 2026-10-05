/**
 * Run the factory once over this repo's Beads backlog, with the production
 * adapters: `bd` for the tracker, `git push` + `gh` for the code host, Docker
 * for sandboxes.
 *
 *   npm run factory
 *
 * Environment:
 *   FACTORY_BASE_BRANCH   Branch work is cut from and PRs target (default: main).
 *   FACTORY_PARALLEL      Most pieces of work built at once (default: 4).
 *
 * Exits 1 if any task it took, or any spec's review, pull request or
 * closing, failed, so a scheduler can notice.
 */
import { beadsTracker } from "./beads-tracker.js";
import { gitHubCodeHost } from "./code-host.js";
import { runFactory } from "./factory.js";

const repoDir = process.cwd();

const report = await runFactory({
  tracker: beadsTracker({ cwd: repoDir }),
  codeHost: gitHubCodeHost({ cwd: repoDir }),
  repoDir,
  baseBranch: process.env.FACTORY_BASE_BRANCH || "main",
  // runFactory rejects anything but a whole number of at least 1.
  parallel: process.env.FACTORY_PARALLEL
    ? Number(process.env.FACTORY_PARALLEL)
    : undefined,
});

if (report.failed > 0 || report.specs.some((s) => s.status === "failed")) {
  process.exitCode = 1;
}
