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

type Seed = Partial<InMemoryIssue> & { id: string };

const TESTING_DECISIONS =
  "## Testing Decisions\nTest at runFactory with the test doubles.";

/** A spec epic that has passed the Spec gate and the Task gate. */
const spec = (overrides: Seed): Seed => ({
  title: "A spec",
  type: "epic",
  labels: ["spec-approved", "ready-for-agent"],
  body: `## Requirements\nSome files.\n\n${TESTING_DECISIONS}`,
  ...overrides,
});

/** A task under a spec. Feature tasks carry no gate label of their own. */
const featureTask = (overrides: Seed & { parent: string }): Seed => ({
  title: `Task ${overrides.id}`,
  type: "task",
  labels: [],
  body: `Add ${overrides.id}.txt.`,
  ...overrides,
});

interface AgentCall {
  readonly role: "implement" | "review";
  /** Task id (implement) or spec id (review). */
  readonly id: string;
  readonly prompt: string;
  /** Files in the sandbox repo when the agent started. */
  readonly files: readonly string[];
}

/**
 * A scripted agent for Feature runs. As implementer it commits
 * `<task-id>.txt`; as reviewer it commits `review.txt` and returns a PR body.
 * `implement` overrides the implementer for chosen task ids. Every call is
 * recorded in `calls`.
 */
const featureAgent = (
  options: {
    implement?: Record<string, (cwd: string) => Promise<string>>;
    review?: (cwd: string) => Promise<string>;
  } = {},
) => {
  const calls: AgentCall[] = [];
  const script = async (cwd: string, prompt: string): Promise<string> => {
    const files = (await git(cwd, "ls-files")).split("\n");
    const task = /^Implement task (\S+):/m.exec(prompt)?.[1];
    if (task) {
      calls.push({ role: "implement", id: task, prompt, files });
      const custom = options.implement?.[task];
      if (custom) return custom(cwd);
      await writeFile(join(cwd, `${task}.txt`), `${task}\n`);
      await git(cwd, "add", "-A");
      await git(cwd, "commit", "-m", `Implement ${task}`);
      return result("done", `Added ${task}.txt`);
    }
    const reviewed = /^Review spec (\S+):/m.exec(prompt)?.[1];
    if (!reviewed) throw new Error(`unexpected prompt:\n${prompt}`);
    calls.push({ role: "review", id: reviewed, prompt, files });
    if (options.review) return options.review(cwd);
    await writeFile(join(cwd, "review.txt"), "reviewed\n");
    await git(cwd, "add", "-A");
    await git(cwd, "commit", "-m", "Address review findings");
    return `Reviewed.\n<factory-result>\n${JSON.stringify({
      status: "done",
      note: "Fixed one finding.",
      prBody: "## Summary\nAll the spec's files.",
    })}\n</factory-result>`;
  };
  return { calls, script };
};

/** Commit subjects on `ref`, newest first. */
const subjects = async (repoDir: string, ref: string) =>
  (await git(repoDir, "log", "--format=%s", ref)).split("\n");

/**
 * Commit `file` on `branch` (created from `main` if missing) through a
 * throwaway worktree, leaving the host checkout alone.
 */
const commitOnBranch = async (
  repoDir: string,
  branch: string,
  file: string,
  content: string,
) => {
  const dir = await mkdtemp(join(tmpdir(), "factory-test-wt-"));
  tempDirs.push(dir);
  const exists = await git(repoDir, "branch", "--list", branch);
  if (exists) await git(repoDir, "worktree", "add", dir, branch);
  else await git(repoDir, "worktree", "add", "-b", branch, dir, "main");
  await writeFile(join(dir, file), content);
  await git(dir, "commit", "-am", `Change ${file} on ${branch}`);
  await git(repoDir, "worktree", "remove", dir);
};

/** The host checkout is still on `main`, at `sha`, with no tracked changes. */
const expectHostUntouched = async (repoDir: string, sha: string) => {
  expect(await git(repoDir, "rev-parse", "main")).toBe(sha);
  expect(await git(repoDir, "branch", "--show-current")).toBe("main");
  expect(
    await git(repoDir, "status", "--porcelain", "--untracked-files=no"),
  ).toBe("");
};

const setup = async (
  seed: Parameters<typeof inMemoryTracker>[0],
  options: Partial<FactoryOptions> & {
    agentScript?: (cwd: string, prompt: string) => Promise<string>;
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

describe("runFactory, Feature workflow", () => {
  it("lands an accepted task on its spec's integration branch, never on the base branch", async () => {
    const agent = featureAgent();
    const { repoDir, baseSha, tracker, run } = await setup(
      [spec({ id: "s-1" }), featureTask({ id: "s-1.1", parent: "s-1" })],
      { agentScript: agent.script, checks: ["test -f s-1.1.txt"] },
    );

    const report = await run();

    expect(await subjects(repoDir, "factory/s-1")).toContain("Implement s-1.1");
    expect(await git(repoDir, "merge-base", "main", "factory/s-1")).toBe(
      baseSha,
    );
    await expectHostUntouched(repoDir, baseSha);

    const task = tracker.issue("s-1.1");
    expect(task.status).toBe("closed");
    expect(task.closeReason).toContain("factory/s-1");

    const implement = agent.calls.find((c) => c.role === "implement")!;
    expect(implement.prompt).toContain("Add s-1.1.txt.");
    expect(implement.prompt).toContain(TESTING_DECISIONS);

    expect(report.outcomes[0]).toMatchObject({
      taskId: "s-1.1",
      workflow: "feature",
      status: "accepted",
    });
  }, 60_000);

  it("runs a blocked task only once its blocker closes, in the same run when the blocker closes during it", async () => {
    const agent = featureAgent();
    const { tracker, run } = await setup(
      [
        spec({ id: "s-1" }),
        featureTask({ id: "s-1.2", parent: "s-1", blockedBy: ["s-1.1"] }),
        featureTask({ id: "s-1.1", parent: "s-1" }),
        featureTask({ id: "s-1.3", parent: "s-1", blockedBy: ["elsewhere"] }),
        { id: "elsewhere", title: "Unrelated open work" },
      ],
      { agentScript: agent.script, checks: [] },
    );

    const report = await run();

    expect(agent.calls.map((c) => c.id)).toEqual(["s-1.1", "s-1.2"]);
    // s-1.2 was cut from the integration branch after s-1.1 merged into it.
    expect(agent.calls[1]!.files).toContain("s-1.1.txt");
    expect(tracker.issue("s-1.1").status).toBe("closed");
    expect(tracker.issue("s-1.2").status).toBe("closed");
    expect(tracker.issue("s-1.3")).toMatchObject({
      status: "open",
      comments: [],
    });
    expect(report).toMatchObject({ taken: 2, accepted: 2, failed: 0 });
  }, 60_000);

  it("leaves a task open with the agent's note when the implementer reports blocked", async () => {
    const agent = featureAgent({
      implement: {
        "s-1.1": async () =>
          result("blocked", "The spec has no Testing Decisions section."),
      },
    });
    const { repoDir, tracker, host, run } = await setup(
      [
        spec({ id: "s-1", body: "## Requirements\nSome files." }),
        featureTask({ id: "s-1.1", parent: "s-1" }),
        featureTask({ id: "s-1.2", parent: "s-1", blockedBy: ["s-1.1"] }),
      ],
      { agentScript: agent.script, checks: [] },
    );
    const integrationBefore = await git(repoDir, "rev-parse", "main");

    const report = await run();

    const task = tracker.issue("s-1.1");
    expect(task.status).not.toBe("closed");
    expect(task.comments.join("\n")).toContain(
      "The spec has no Testing Decisions section.",
    );
    expect(agent.calls.map((c) => c.id)).toEqual(["s-1.1"]);
    expect(tracker.issue("s-1.2").status).toBe("open");
    expect(await git(repoDir, "rev-parse", "factory/s-1")).toBe(
      integrationBefore,
    );
    expect(host.pullRequests).toHaveLength(0);
    expect(report).toMatchObject({ taken: 1, accepted: 0, failed: 1 });
  }, 60_000);

  it("fails a task whose merge into the integration branch conflicts, leaving that branch as it was", async () => {
    const agent = featureAgent();
    const { repoDir, baseSha, tracker, run } = await setup(
      [spec({ id: "s-1" }), featureTask({ id: "s-1.1", parent: "s-1" })],
      { agentScript: agent.script, checks: [] },
    );
    // An earlier run left the integration branch and a stale task branch
    // that disagree about README.md.
    await commitOnBranch(repoDir, "factory/s-1", "README.md", "integration\n");
    await commitOnBranch(repoDir, "factory/s-1.1", "README.md", "stale\n");
    const integrationBefore = await git(repoDir, "rev-parse", "factory/s-1");

    const report = await run();

    expect(await git(repoDir, "rev-parse", "factory/s-1")).toBe(
      integrationBefore,
    );
    const task = tracker.issue("s-1.1");
    expect(task.status).not.toBe("closed");
    expect(task.labels).toContain("factory-failed");
    expect(task.comments.join("\n")).toMatch(/conflict/i);
    expect(task.comments.join("\n")).toContain("README.md");
    await expectHostUntouched(repoDir, baseSha);
    expect(report).toMatchObject({ taken: 1, accepted: 0, failed: 1 });
  }, 60_000);

  it("opens one pull request per spec, after all its tasks close and a review pass, and never a second", async () => {
    const agent = featureAgent();
    const { repoDir, baseSha, tracker, host, run } = await setup(
      [
        spec({ id: "s-1", title: "Spec one" }),
        featureTask({ id: "s-1.1", parent: "s-1" }),
        featureTask({ id: "s-1.2", parent: "s-1", blockedBy: ["outside"] }),
        { id: "outside", title: "Work outside the factory" },
      ],
      { agentScript: agent.script, checks: [] },
    );

    // s-1.2 is still open: no review, no pull request.
    await run();
    expect(tracker.issue("s-1.1").status).toBe("closed");
    expect(agent.calls.map((c) => c.role)).toEqual(["implement"]);
    expect(host.pullRequests).toHaveLength(0);

    tracker.issue("outside").status = "closed";
    const report = await run();

    expect(agent.calls.map((c) => `${c.role} ${c.id}`)).toEqual([
      "implement s-1.1",
      "implement s-1.2",
      "review s-1",
    ]);
    const review = agent.calls[2]!;
    expect(review.files).toEqual(
      expect.arrayContaining(["s-1.1.txt", "s-1.2.txt"]),
    );
    expect(review.prompt).toContain("main");

    expect(host.pullRequests).toHaveLength(1);
    const pr = host.pullRequests[0]!;
    expect(pr).toMatchObject({ branch: "factory/s-1", base: "main" });
    expect(pr.title).toContain("Spec one");
    for (const text of ["s-1", "s-1.1", "s-1.2", "All the spec's files."]) {
      expect(pr.body).toContain(text);
    }
    expect(await subjects(repoDir, pr.headSha)).toEqual(
      expect.arrayContaining([
        "Address review findings",
        "Implement s-1.1",
        "Implement s-1.2",
      ]),
    );
    expect(report.pullRequests).toEqual([pr.url]);

    const specIssue = tracker.issue("s-1");
    expect(specIssue.comments.join("\n")).toContain(pr.url);
    expect(specIssue.status).toBe("open");
    await expectHostUntouched(repoDir, baseSha);

    // A later run, even one that lands new work on the spec, opens no second
    // pull request.
    await run();
    tracker.add(featureTask({ id: "s-1.3", parent: "s-1" }));
    const later = await run();
    expect(tracker.issue("s-1.3").status).toBe("closed");
    expect(later.pullRequests).toEqual([]);
    expect(host.pullRequests).toHaveLength(1);
    expect(agent.calls.filter((c) => c.role === "review")).toHaveLength(1);
  }, 60_000);

  it("opens no pull request, and comments on the spec, when the checks fail after the review pass", async () => {
    const agent = featureAgent({
      review: async (cwd) => {
        await writeFile(join(cwd, "broken.txt"), "oops\n");
        await git(cwd, "add", "-A");
        await git(cwd, "commit", "-m", "A review fix that breaks the build");
        return `<factory-result>${JSON.stringify({
          status: "done",
          note: "Fixed it.",
          prBody: "Body.",
        })}</factory-result>`;
      },
    });
    const { tracker, host, run } = await setup(
      [spec({ id: "s-1" }), featureTask({ id: "s-1.1", parent: "s-1" })],
      {
        agentScript: agent.script,
        checks: ["test ! -f broken.txt || (echo 'build broken' && exit 1)"],
      },
    );

    const report = await run();

    expect(agent.calls.map((c) => c.role)).toEqual(["implement", "review"]);
    expect(host.pullRequests).toHaveLength(0);
    expect(host.pushed.size).toBe(0);
    const specIssue = tracker.issue("s-1");
    expect(specIssue.comments.join("\n")).toContain("build broken");
    expect(specIssue.status).toBe("open");
    expect(report.pullRequests).toEqual([]);
  }, 60_000);

  it("does not take tasks under a spec missing either gate label", async () => {
    const agent = featureAgent();
    const { repoDir, tracker, host, run } = await setup(
      [
        spec({ id: "s-draft", labels: [] }),
        spec({ id: "s-approved", labels: ["spec-approved"] }),
        spec({ id: "s-ticketed", labels: ["ready-for-agent"] }),
        featureTask({ id: "s-draft.1", parent: "s-draft" }),
        featureTask({ id: "s-approved.1", parent: "s-approved" }),
        featureTask({ id: "s-ticketed.1", parent: "s-ticketed" }),
      ],
      { agentScript: agent.script },
    );

    const report = await run();

    expect(report).toMatchObject({ taken: 0, pullRequests: [] });
    expect(agent.calls).toEqual([]);
    expect(host.pushed.size).toBe(0);
    for (const id of ["s-draft.1", "s-approved.1", "s-ticketed.1"]) {
      expect(tracker.issue(id)).toMatchObject({ status: "open", comments: [] });
    }
    expect(await git(repoDir, "branch", "--list", "factory/*")).toBe("");
  }, 60_000);
});
