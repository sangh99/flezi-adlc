import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { claudeCode } from "../../src/index.js";
import { runFactory, type FactoryOptions } from "./factory.js";
import {
  fakeCodeHost,
  inMemoryTracker,
  scriptedSandbox,
  type InMemoryIssue,
} from "./test-doubles.js";

const execFileAsync = promisify(execFile);

const git = async (cwd: string, ...args: string[]): Promise<string> =>
  (await execFileAsync("git", args, { cwd })).stdout.trim();

const tempDirs: string[] = [];
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

/** A real git repo with one commit on `main`. */
const makeRepo = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "factory-test-"));
  tempDirs.push(dir);
  await git(dir, "init", "-b", "main");
  await writeFile(join(dir, "README.md"), "hello\n");
  await git(dir, "add", "README.md");
  await git(dir, "commit", "-m", "initial");
  return dir;
};

const result = (status: "done" | "blocked", note: string): string =>
  `All finished.\n<factory-result>\n${JSON.stringify({ status, note })}\n</factory-result>`;

/** An agent that commits one file and reports done. */
const committingAgent = async (cwd: string): Promise<string> => {
  await writeFile(join(cwd, "feature.txt"), "implemented\n");
  await git(cwd, "add", "feature.txt");
  await git(cwd, "commit", "-m", "Implement the feature");
  return result("done", "Added feature.txt");
};

const quickTask = (
  overrides: Partial<InMemoryIssue> & { id: string },
): Partial<InMemoryIssue> & { id: string } => ({
  title: "Add a feature",
  type: "task",
  labels: ["ready-for-agent"],
  body: "Add feature.txt.\n\n## Testing\nCheck feature.txt exists.",
  ...overrides,
});

const setup = async (
  seed: Parameters<typeof inMemoryTracker>[0],
  options: Partial<FactoryOptions> & {
    agentScript?: (cwd: string) => Promise<string>;
  } = {},
) => {
  const repoDir = await makeRepo();
  const baseSha = await git(repoDir, "rev-parse", "main");
  const tracker = inMemoryTracker(seed);
  const host = fakeCodeHost(repoDir);
  const { agentScript = committingAgent, ...rest } = options;
  const run = () =>
    runFactory({
      tracker: tracker.tracker,
      codeHost: host.codeHost,
      repoDir,
      baseBranch: "main",
      agent: claudeCode("test-model"),
      sandbox: scriptedSandbox(agentScript),
      checks: ["test -f feature.txt"],
      sandboxSetup: [],
      copyToWorktree: [],
      log: () => {},
      ...rest,
    });
  return { repoDir, baseSha, tracker, host, run };
};

describe("runFactory", () => {
  it("takes an eligible Quick task through to one pull request and closes it", async () => {
    const { repoDir, baseSha, tracker, host, run } = await setup([
      quickTask({ id: "t-1" }),
    ]);

    const report = await run();

    expect(host.pullRequests).toHaveLength(1);
    const pr = host.pullRequests[0]!;
    expect(pr.base).toBe("main");
    expect(pr.branch).not.toBe("main");
    expect(pr.body).toContain("t-1");
    expect(await git(repoDir, "log", "--format=%s", pr.headSha)).toContain(
      "Implement the feature",
    );

    expect(await git(repoDir, "rev-parse", "main")).toBe(baseSha);
    expect(await git(repoDir, "branch", "--show-current")).toBe("main");

    const task = tracker.issue("t-1");
    expect(task.status).toBe("closed");
    expect(task.closeReason).toBeTruthy();
    expect(task.comments.join("\n")).toContain(pr.url);

    expect(report).toMatchObject({
      taken: 1,
      accepted: 1,
      failed: 0,
      pullRequests: [pr.url],
    });
  }, 60_000);

  it("does not take a task without ready-for-agent, or one the ready list doesn't report", async () => {
    const { repoDir, tracker, host, run } = await setup([
      quickTask({ id: "t-no-gate", labels: [] }),
      quickTask({ id: "t-blocker", labels: [] }),
      quickTask({ id: "t-blocked", blockedBy: ["t-blocker"] }),
    ]);

    const report = await run();

    expect(report).toMatchObject({ taken: 0, accepted: 0, pullRequests: [] });
    expect(host.pullRequests).toHaveLength(0);
    expect(host.pushed.size).toBe(0);
    for (const id of ["t-no-gate", "t-blocked"]) {
      expect(tracker.issue(id)).toMatchObject({ status: "open", comments: [] });
    }
    expect(await git(repoDir, "branch", "--list", "factory/*")).toBe("");
  }, 60_000);

  it("opens no pull request and leaves the task open when a required check fails", async () => {
    const { baseSha, repoDir, tracker, host, run } = await setup(
      [quickTask({ id: "t-1" })],
      { checks: ["test -f feature.txt", "echo 'type error' && exit 1"] },
    );

    const report = await run();

    expect(host.pullRequests).toHaveLength(0);
    expect(host.pushed.size).toBe(0);
    const task = tracker.issue("t-1");
    expect(task.status).not.toBe("closed");
    expect(task.labels).toContain("factory-failed");
    expect(task.comments.join("\n")).toContain("type error");
    expect(await git(repoDir, "rev-parse", "main")).toBe(baseSha);
    expect(report).toMatchObject({ taken: 1, accepted: 0, failed: 1 });
  }, 60_000);

  it("opens no pull request when the agent reports blocked, and records its note", async () => {
    const { tracker, host, run } = await setup([quickTask({ id: "t-1" })], {
      agentScript: async () =>
        result("blocked", "The task has no testing note."),
    });

    const report = await run();

    expect(host.pullRequests).toHaveLength(0);
    const task = tracker.issue("t-1");
    expect(task.status).not.toBe("closed");
    expect(task.comments.join("\n")).toContain("The task has no testing note.");
    expect(report).toMatchObject({ taken: 1, accepted: 0, failed: 1 });
  }, 60_000);
});
