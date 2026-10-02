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
  readonly role: "implement" | "review" | "merge";
  /** Task id (implement, merge) or spec id (review). */
  readonly id: string;
  readonly prompt: string;
  /** Files in the sandbox repo when the agent started. */
  readonly files: readonly string[];
}

/**
 * A scripted agent for Feature runs. As implementer it commits
 * `<task-id>.txt`; as reviewer it commits `review.txt` and returns a PR body;
 * as merge agent it runs `merge`, given the integration commit to merge.
 * `implement` overrides the implementer for chosen task ids. Every call is
 * recorded in `calls`.
 */
const featureAgent = (
  options: {
    implement?: Record<string, (cwd: string) => Promise<string>>;
    review?: (cwd: string) => Promise<string>;
    merge?: (cwd: string, integrationCommit: string) => Promise<string>;
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
    const merging = /^Resolve the merge conflicts of task (\S+):/m.exec(
      prompt,
    )?.[1];
    if (merging) {
      calls.push({ role: "merge", id: merging, prompt, files });
      const commit = /git merge --no-ff (\S+)/.exec(prompt)?.[1];
      if (!options.merge || !commit) throw new Error("no merge script");
      return options.merge(cwd, commit);
    }
    const reviewed = /^Review spec (\S+):/m.exec(prompt)?.[1];
    if (!reviewed) throw new Error(`unexpected prompt:\n${prompt}`);
    calls.push({ role: "review", id: reviewed, prompt, files });
    return (options.review ?? passingReview)(cwd);
  };
  return { calls, script };
};

/** A reviewer that commits `review.txt` and returns a PR body. */
const passingReview = async (cwd: string): Promise<string> => {
  await writeFile(join(cwd, "review.txt"), "reviewed\n");
  await git(cwd, "add", "-A");
  await git(cwd, "commit", "-m", "Address review findings");
  return `Reviewed.\n<factory-result>\n${JSON.stringify({
    status: "done",
    note: "Fixed one finding.",
    prBody: "## Summary\nAll the spec's files.",
  })}\n</factory-result>`;
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

/**
 * An implementer for `taskId` of spec `s-1` that changes README.md, while
 * another change to README.md lands on the integration branch as it works,
 * so the task's merge back conflicts. Set `repoDir` before the run.
 */
const conflictingTask = (taskId: string) => {
  const conflict = {
    repoDir: "",
    /** Where the integration branch was once the other change landed. */
    integrationAfterMove: "",
    implement: {
      [taskId]: async (cwd: string) => {
        await commitOnBranch(
          conflict.repoDir,
          "factory/s-1",
          "README.md",
          "integration\n",
        );
        conflict.integrationAfterMove = await git(
          conflict.repoDir,
          "rev-parse",
          "factory/s-1",
        );
        await writeFile(join(cwd, "README.md"), "task\n");
        await git(cwd, "commit", "-am", `Implement ${taskId}`);
        return result("done", "Changed README.md");
      },
    },
  };
  return conflict;
};

/** Merge `commit` in `cwd`, settle README.md's conflict as `content`, commit. */
const resolveMerge = async (cwd: string, commit: string, content: string) => {
  // Exits non-zero on the conflict, which is the point.
  await execFileAsync("git", ["merge", "--no-ff", commit], { cwd }).catch(
    () => {},
  );
  await writeFile(join(cwd, "README.md"), content);
  await git(cwd, "add", "README.md");
  await git(cwd, "commit", "--no-edit");
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

  it.each([
    {
      failure: "reports blocked",
      expectNote: "Can't tell which README wins.",
      merge: async () => result("blocked", "Can't tell which README wins."),
    },
    {
      failure: "breaks the required checks",
      expectNote: "test ! -f broken.txt",
      merge: async (cwd: string, commit: string) => {
        await resolveMerge(cwd, commit, "integration and task\n");
        await writeFile(join(cwd, "broken.txt"), "oops\n");
        await git(cwd, "add", "-A");
        await git(cwd, "commit", "-m", "Break the build");
        return result("done", "Merged.");
      },
    },
    {
      failure: "leaves the branch conflicting",
      expectNote: "README.md",
      merge: async (cwd: string) => {
        await writeFile(join(cwd, "README.md"), "still only the task\n");
        await git(cwd, "commit", "-am", "Not a merge");
        return result("done", "Merged.");
      },
    },
  ])(
    "fails a conflicting task after one merge agent that $failure, leaving the integration branch as it was",
    async ({ expectNote, merge }) => {
      const conflict = conflictingTask("s-1.1");
      const agent = featureAgent({ implement: conflict.implement, merge });
      const { repoDir, baseSha, tracker, run } = await setup(
        [spec({ id: "s-1" }), featureTask({ id: "s-1.1", parent: "s-1" })],
        { agentScript: agent.script, checks: ["test ! -f broken.txt"] },
      );
      conflict.repoDir = repoDir;

      const report = await run();

      expect(agent.calls.map((c) => `${c.role} ${c.id}`)).toEqual([
        "implement s-1.1",
        "merge s-1.1",
      ]);
      expect(await git(repoDir, "rev-parse", "factory/s-1")).toBe(
        conflict.integrationAfterMove,
      );
      const task = tracker.issue("s-1.1");
      expect(task).toMatchObject({ status: "open", assignee: undefined });
      expect(task.labels).toContain("factory-failed");
      expect(task.comments.join("\n")).toMatch(/conflict/i);
      expect(task.comments.join("\n")).toContain(expectNote);
      await expectHostUntouched(repoDir, baseSha);
      expect(report).toMatchObject({ taken: 1, accepted: 0, failed: 1 });
    },
    60_000,
  );

  it("lands a conflicting task once the merge agent resolves the conflict and the checks pass again", async () => {
    const conflict = conflictingTask("s-1.1");
    const agent = featureAgent({
      implement: conflict.implement,
      merge: async (cwd, commit) => {
        await resolveMerge(cwd, commit, "integration and task\n");
        return result("done", "Kept both README lines.");
      },
    });
    const { repoDir, baseSha, tracker, run } = await setup(
      [spec({ id: "s-1" }), featureTask({ id: "s-1.1", parent: "s-1" })],
      { agentScript: agent.script, checks: ["grep -q task README.md"] },
    );
    conflict.repoDir = repoDir;

    const report = await run();

    // The spec's review follows, since its only task closed.
    expect(agent.calls.map((c) => `${c.role} ${c.id}`)).toEqual([
      "implement s-1.1",
      "merge s-1.1",
      "review s-1",
    ]);
    const merge = agent.calls[1]!;
    expect(merge.prompt).toContain(conflict.integrationAfterMove);
    expect(merge.prompt).toContain("README.md");
    expect(await git(repoDir, "show", "factory/s-1:README.md")).toBe(
      "integration and task",
    );
    expect(await subjects(repoDir, "factory/s-1")).toEqual(
      expect.arrayContaining([
        "Implement s-1.1",
        "Change README.md on factory/s-1",
      ]),
    );
    expect(tracker.issue("s-1.1").status).toBe("closed");
    await expectHostUntouched(repoDir, baseSha);
    expect(report).toMatchObject({ taken: 1, accepted: 1, failed: 0 });
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

const FAILING_COMMAND =
  "npx vitest run src/parse.test.ts -t 'drops the trailing newline'";
const ROOT_CAUSE = "parseLines splits on newlines and keeps the empty tail.";

/** A bug that has been diagnosed and has passed the Diagnosis gate. */
const bug = (overrides: Seed): Seed => ({
  title: "Parser returns a trailing empty line",
  type: "bug",
  labels: ["ready-for-agent"],
  body: [
    "## Symptom\nparseLines on 'a' plus a newline returns two lines.",
    `## Steps to Reproduce\n\`${FAILING_COMMAND}\`\n\nexpected 1 line, got 2`,
    `## Root Cause\n${ROOT_CAUSE}`,
    "## Fix Approach\nDrop the empty tail in parseLines.",
    "## Testing\nsrc/parse.test.ts, through parseLines.",
    "## Acceptance Criteria\n- [ ] The command goes green",
  ].join("\n\n"),
  ...overrides,
});

/**
 * A scripted implementer for Bugfix runs: commits `fix.txt` and records the
 * prompt of every bug it is asked to fix.
 */
const bugfixAgent = () => {
  const calls: { id: string; prompt: string }[] = [];
  const script = async (cwd: string, prompt: string): Promise<string> => {
    const id = /^Fix bug (\S+):/m.exec(prompt)?.[1];
    if (!id) throw new Error(`unexpected prompt:\n${prompt}`);
    calls.push({ id, prompt });
    await writeFile(join(cwd, "fix.txt"), `${id}\n`);
    await git(cwd, "add", "-A");
    await git(cwd, "commit", "-m", `Fix ${id}`);
    return result("done", "Added a regression test and fixed parseLines.");
  };
  return { calls, script };
};

describe("runFactory, Bugfix workflow", () => {
  it("takes a bug only once it has passed the Diagnosis gate", async () => {
    const agent = bugfixAgent();
    const { tracker, run } = await setup(
      [bug({ id: "b-gated" }), bug({ id: "b-undiagnosed", labels: [] })],
      { agentScript: agent.script, checks: ["test -f fix.txt"] },
    );

    const report = await run();

    expect(agent.calls.map((c) => c.id)).toEqual(["b-gated"]);
    expect(tracker.issue("b-undiagnosed")).toMatchObject({
      status: "open",
      comments: [],
    });
    expect(report.outcomes).toEqual([
      expect.objectContaining({
        taskId: "b-gated",
        workflow: "bugfix",
        status: "accepted",
      }),
    ]);
  }, 60_000);

  it("opens one pull request for an accepted bug, naming it and its root cause, and closes it", async () => {
    const agent = bugfixAgent();
    const { repoDir, baseSha, tracker, host, run } = await setup(
      [bug({ id: "b-1" })],
      { agentScript: agent.script, checks: ["test -f fix.txt"] },
    );

    const report = await run();

    expect(host.pullRequests).toHaveLength(1);
    const pr = host.pullRequests[0]!;
    expect(pr.base).toBe("main");
    expect(pr.branch).not.toBe("main");
    expect(pr.body).toContain("b-1");
    expect(pr.body).toContain(ROOT_CAUSE);
    expect(await subjects(repoDir, pr.headSha)).toContain("Fix b-1");
    await expectHostUntouched(repoDir, baseSha);

    const issue = tracker.issue("b-1");
    expect(issue.status).toBe("closed");
    expect(issue.comments.join("\n")).toContain(pr.url);
    expect(report).toMatchObject({
      taken: 1,
      accepted: 1,
      failed: 0,
      pullRequests: [pr.url],
    });
  }, 60_000);

  it("gives the implementer the diagnosis and asks for the regression test before the fix", async () => {
    const agent = bugfixAgent();
    const { run } = await setup([bug({ id: "b-1" })], {
      agentScript: agent.script,
      checks: [],
    });

    await run();

    const { prompt } = agent.calls[0]!;
    expect(prompt).toContain(FAILING_COMMAND);
    expect(prompt).toContain(ROOT_CAUSE);
    expect(prompt).toContain("## Testing\nsrc/parse.test.ts");
    const instructions = prompt.slice(prompt.indexOf("</bug>"));
    expect(instructions).toMatch(
      /regression test[^\n]*confirm it fails[\s\S]*fix the bug/i,
    );
    expect(instructions).toMatch(/no seam in Testing[\s\S]*report `blocked`/);
  }, 60_000);

  it("takes a diagnosed bug filed under a spec through its own gate, with its own pull request", async () => {
    const agent = bugfixAgent();
    const { repoDir, tracker, host, run } = await setup(
      [spec({ id: "s-1", labels: [] }), bug({ id: "b-1", parent: "s-1" })],
      { agentScript: agent.script, checks: ["test -f fix.txt"] },
    );

    const report = await run();

    expect(host.pullRequests).toHaveLength(1);
    expect(host.pullRequests[0]).toMatchObject({
      branch: "factory/b-1",
      base: "main",
    });
    expect(await git(repoDir, "branch", "--list", "factory/s-1")).toBe("");
    expect(tracker.issue("b-1").status).toBe("closed");
    expect(report.outcomes[0]).toMatchObject({ workflow: "bugfix" });
  }, 60_000);
});

describe("runFactory, failures and retries", () => {
  it("parks a failed task until a person removes factory-failed, then retries it from a fresh branch", async () => {
    const attempts: { files: readonly string[] }[] = [];
    const { repoDir, tracker, host, run } = await setup(
      [quickTask({ id: "t-1" })],
      {
        agentScript: async (cwd) => {
          attempts.push({ files: (await git(cwd, "ls-files")).split("\n") });
          if (attempts.length === 1) {
            await writeFile(join(cwd, "first-attempt.txt"), "half done\n");
            await git(cwd, "add", "-A");
            await git(cwd, "commit", "-m", "A first attempt");
            return result("blocked", "Stuck on the first attempt.");
          }
          return committingAgent(cwd);
        },
      },
    );

    const first = await run();

    expect(first).toMatchObject({ taken: 1, failed: 1 });
    const parked = tracker.issue("t-1");
    expect(parked.labels).toContain("factory-failed");
    expect(parked.comments.join("\n")).toContain("Stuck on the first attempt.");
    // The claim is given back: open, with nobody holding it.
    expect(parked).toMatchObject({ status: "open", assignee: undefined });

    const skipped = await run();
    expect(skipped).toMatchObject({ taken: 0 });
    expect(attempts).toHaveLength(1);

    await tracker.tracker.removeLabel("t-1", "factory-failed");
    const retried = await run();

    expect(retried).toMatchObject({ taken: 1, accepted: 1 });
    expect(attempts).toHaveLength(2);
    expect(attempts[1]!.files).not.toContain("first-attempt.txt");
    const pr = host.pullRequests[0]!;
    expect(await subjects(repoDir, pr.headSha)).not.toContain(
      "A first attempt",
    );
    expect(tracker.issue("t-1").status).toBe("closed");
  }, 60_000);

  it.each([
    { workflow: "quick", seed: quickTask({ id: "t-1" }) },
    { workflow: "bugfix", seed: bug({ id: "t-1" }) },
  ])(
    "on retrying a $workflow item whose pull request opened before the factory failed, closes it without building or opening another",
    async ({ seed }) => {
      let builds = 0;
      const { tracker, host, run } = await setup([seed], {
        checks: [],
        agentScript: async (cwd) => {
          builds++;
          return committingAgent(cwd);
        },
      });
      const close = tracker.tracker.close;
      tracker.tracker.close = async () => {
        throw new Error("bd close failed");
      };

      const first = await run();

      expect(first).toMatchObject({ taken: 1, failed: 1 });
      expect(host.pullRequests).toHaveLength(1);
      const pr = host.pullRequests[0]!;
      expect(tracker.issue("t-1").labels).toContain("factory-failed");

      tracker.tracker.close = close;
      await tracker.tracker.removeLabel("t-1", "factory-failed");
      const retried = await run();

      expect(retried).toMatchObject({ taken: 1, accepted: 1, failed: 0 });
      expect(builds).toBe(1);
      expect(host.pullRequests).toHaveLength(1);
      const task = tracker.issue("t-1");
      expect(task.status).toBe("closed");
      expect(task.closeReason).toContain(pr.url);
      expect(task.comments.join("\n")).toContain(pr.url);
    },
    60_000,
  );

  it("on retrying a Feature task that merged before the factory failed, closes it without building or merging it again", async () => {
    const agent = featureAgent();
    const { repoDir, tracker, host, run } = await setup(
      [spec({ id: "s-1" }), featureTask({ id: "s-1.1", parent: "s-1" })],
      { agentScript: agent.script, checks: [] },
    );
    const close = tracker.tracker.close;
    tracker.tracker.close = async () => {
      throw new Error("bd close failed");
    };

    await run();

    expect(tracker.issue("s-1.1").labels).toContain("factory-failed");
    const integration = await git(repoDir, "rev-parse", "factory/s-1");

    tracker.tracker.close = close;
    await tracker.tracker.removeLabel("s-1.1", "factory-failed");
    const retried = await run();

    expect(retried.outcomes).toEqual([
      expect.objectContaining({ taskId: "s-1.1", status: "accepted" }),
    ]);
    expect(tracker.issue("s-1.1").status).toBe("closed");
    expect(agent.calls.map((c) => `${c.role} ${c.id}`)).toEqual([
      "implement s-1.1",
      "review s-1",
    ]);
    // The review pass builds on the integration branch the first run left.
    expect(await git(repoDir, "rev-parse", "factory/s-1^")).toBe(integration);
    expect(host.pullRequests).toHaveLength(1);
  }, 60_000);

  /**
   * A spec whose first review leaves an uncommitted file behind and reports
   * blocked; every later review passes.
   */
  const specWithDirtyFailedReview = async () => {
    let reviews = 0;
    const agent = featureAgent({
      review: async (cwd) => {
        if (++reviews > 1) return passingReview(cwd);
        await writeFile(join(cwd, "half-done.txt"), "not committed\n");
        return result("blocked", "Half way through a finding.");
      },
    });
    const ctx = await setup(
      [spec({ id: "s-1" }), featureTask({ id: "s-1.1", parent: "s-1" })],
      { agentScript: agent.script, checks: [] },
    );
    await ctx.run();
    expect(ctx.tracker.issue("s-1").labels).toContain("factory-failed");
    return ctx;
  };

  it("lands later work on a spec whose failed review left uncommitted changes behind", async () => {
    const { repoDir, baseSha, tracker, host, run } =
      await specWithDirtyFailedReview();

    // A person files a task for the finding and asks for a retry.
    tracker.add(featureTask({ id: "s-1.2", parent: "s-1" }));
    await tracker.tracker.removeLabel("s-1", "factory-failed");
    const report = await run();

    expect(report.outcomes).toEqual([
      expect.objectContaining({ taskId: "s-1.2", status: "accepted" }),
    ]);
    expect(await subjects(repoDir, "factory/s-1")).toContain("Implement s-1.2");
    expect(host.pullRequests).toHaveLength(1);
    const pr = host.pullRequests[0]!;
    expect(pr).toMatchObject({ branch: "factory/s-1" });
    // The failed review's leftovers don't reach the pull request.
    expect(
      await git(repoDir, "ls-tree", "--name-only", pr.headSha),
    ).not.toContain("half-done.txt");
    await expectHostUntouched(repoDir, baseSha);
  }, 60_000);

  it("leaves alone a person's own worktree of the integration branch, and merges nothing into it", async () => {
    const agent = featureAgent();
    const { repoDir, tracker, run } = await setup(
      [spec({ id: "s-1" }), featureTask({ id: "s-1.1", parent: "s-1" })],
      { agentScript: agent.script, checks: [] },
    );
    const own = await mkdtemp(join(tmpdir(), "factory-test-own-"));
    tempDirs.push(own);
    await git(repoDir, "branch", "factory/s-1", "main");
    await git(repoDir, "worktree", "add", own, "factory/s-1");
    await writeFile(join(own, "mine.txt"), "uncommitted\n");

    const report = await run();

    expect(report).toMatchObject({ taken: 1, failed: 1 });
    expect(tracker.issue("s-1.1").comments.join("\n")).toContain("checked out");
    expect(await git(own, "status", "--porcelain")).toContain("mine.txt");
    expect(await subjects(repoDir, "factory/s-1")).not.toContain(
      "Implement s-1.1",
    );
  }, 60_000);

  it("retries a failed review without the uncommitted changes it left behind", async () => {
    const { repoDir, baseSha, tracker, host, run } =
      await specWithDirtyFailedReview();

    await tracker.tracker.removeLabel("s-1", "factory-failed");
    const report = await run();

    expect(report.specs).toEqual([
      expect.objectContaining({ specId: "s-1", status: "pr-opened" }),
    ]);
    const pr = host.pullRequests[0]!;
    expect(
      await git(repoDir, "ls-tree", "--name-only", pr.headSha),
    ).not.toContain("half-done.txt");
    await expectHostUntouched(repoDir, baseSha);
  }, 60_000);

  it("keeps a task's claim alive while its agent runs", async () => {
    let waitForHeartbeat: (id: string) => Promise<void> = async () => {};
    const { tracker, run } = await setup([quickTask({ id: "t-1" })], {
      heartbeatMs: 5,
      agentScript: async (cwd) => {
        // A long agent run: it outlasts at least one heartbeat interval.
        const renewed = await within(5_000, waitForHeartbeat("t-1"));
        if (!renewed) return result("blocked", "The claim was never renewed.");
        return committingAgent(cwd);
      },
    });
    waitForHeartbeat = tracker.nextHeartbeat;

    const report = await run();

    expect(report).toMatchObject({ taken: 1, accepted: 1 });
    expect(tracker.issue("t-1").heartbeats).toBeGreaterThan(0);
  }, 60_000);

  it("parks a failed task and gives its claim back even when commenting on it fails", async () => {
    const { tracker, run } = await setup([quickTask({ id: "t-1" })], {
      agentScript: async () => result("blocked", "Stuck."),
    });
    tracker.tracker.comment = async () => {
      throw new Error("bd comment failed");
    };

    const report = await run();

    expect(report).toMatchObject({ taken: 1, failed: 1 });
    const task = tracker.issue("t-1");
    expect(task.labels).toContain("factory-failed");
    expect(task).toMatchObject({ status: "open", assignee: undefined });
  }, 60_000);

  it("lets work already running finish before failing when the ready list can't be read", async () => {
    let listings = 0;
    let listingFailed: () => void = () => {};
    const secondListing = new Promise<void>((r) => (listingFailed = r));
    const { tracker, run } = await setup(
      [quickTask({ id: "t-1" }), quickTask({ id: "t-2" })],
      {
        parallel: 2,
        agentScript: async (cwd, prompt) => {
          // t-2 is still working when t-1 frees its slot.
          if (prompt.includes("t-2")) await secondListing;
          return committingAgent(cwd);
        },
      },
    );
    const listReady = tracker.tracker.listReady;
    tracker.tracker.listReady = async () => {
      if (++listings === 1) return listReady();
      listingFailed();
      throw new Error("bd ready failed");
    };

    const error = await run().then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(String(error)).toContain("bd ready failed");
    // Nothing is left mid-flight or claimed once the run gives up.
    expect(tracker.issue("t-1").status).toBe("closed");
    expect(tracker.issue("t-2").status).toBe("closed");
  }, 60_000);
});

describe("runFactory, spec lifecycle across runs", () => {
  it("closes a spec at the start of the first run after its pull request is merged", async () => {
    const agent = featureAgent();
    const { tracker, host, run } = await setup(
      [spec({ id: "s-1" }), featureTask({ id: "s-1.1", parent: "s-1" })],
      { agentScript: agent.script, checks: [] },
    );
    await run();
    const pr = host.pullRequests[0]!;
    expect(tracker.issue("s-1").labels).toContain("factory-pr-opened");

    // Not merged yet: the spec stays open.
    await run();
    expect(tracker.issue("s-1").status).toBe("open");

    host.merge(pr.url);
    const report = await run();

    const closed = tracker.issue("s-1");
    expect(closed.status).toBe("closed");
    expect(closed.closeReason).toContain(pr.url);
    expect(report.specs).toEqual([
      expect.objectContaining({ specId: "s-1", status: "closed" }),
    ]);
    expect(report.pullRequests).toEqual([]);
  }, 60_000);

  it("opens a spec's pull request in a later run when its tasks closed in an earlier one", async () => {
    const agent = featureAgent();
    const closedTask = {
      status: "closed",
      closeReason: "Merged into factory/s-1",
    };
    const { repoDir, tracker, host, run } = await setup(
      [
        // An earlier run merged both tasks, then stopped before the PR step.
        spec({ id: "s-1" }),
        featureTask({ id: "s-1.1", parent: "s-1", ...closedTask }),
        // An earlier review of s-2 failed: parked until a person says retry.
        spec({
          id: "s-2",
          labels: ["spec-approved", "ready-for-agent", "factory-failed"],
        }),
        featureTask({ id: "s-2.1", parent: "s-2", ...closedTask }),
      ],
      { agentScript: agent.script, checks: [] },
    );
    await commitOnBranch(repoDir, "factory/s-1", "README.md", "s-1.1 landed\n");

    const report = await run();

    expect(agent.calls.map((c) => `${c.role} ${c.id}`)).toEqual(["review s-1"]);
    expect(host.pullRequests).toHaveLength(1);
    expect(host.pullRequests[0]).toMatchObject({ branch: "factory/s-1" });
    expect(tracker.issue("s-1").labels).toContain("factory-pr-opened");
    expect(report.specs).toEqual([
      expect.objectContaining({ specId: "s-1", status: "pr-opened" }),
    ]);

    await tracker.tracker.removeLabel("s-2", "factory-failed");
    await run();
    expect(agent.calls.map((c) => `${c.role} ${c.id}`)).toEqual([
      "review s-1",
      "review s-2",
    ]);
    expect(host.pullRequests.map((pr) => pr.branch)).toEqual([
      "factory/s-1",
      "factory/s-2",
    ]);
  }, 60_000);
});

/** Whether `promise` settles within `ms`. */
const within = async (ms: number, promise: Promise<unknown>) => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([promise.then(() => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Counts agents running at once. The first `limit` agents wait for each
 * other, so a factory that can run `limit` at once must; a factory that
 * runs fewer gives up waiting after a while and shows a lower `max`.
 */
const concurrencyGauge = (limit: number) => {
  let active = 0;
  let open = false;
  let release: () => void = () => {};
  const allArrived = new Promise<void>((resolve) => (release = resolve));
  const gauge = {
    max: 0,
    /** Run `work` as one agent. */
    run: async <T>(work: () => Promise<T>): Promise<T> => {
      active++;
      gauge.max = Math.max(gauge.max, active);
      if (active >= limit) {
        open = true;
        release();
      }
      try {
        if (!open) await within(5_000, allArrived);
        return await work();
      } finally {
        active--;
      }
    },
  };
  return gauge;
};

describe("runFactory, in parallel", () => {
  it("runs eligible tasks in parallel, never more than the limit at once", async () => {
    const gauge = concurrencyGauge(2);
    const { tracker, host, run } = await setup(
      ["t-1", "t-2", "t-3", "t-4", "t-5"].map((id) => quickTask({ id })),
      {
        parallel: 2,
        agentScript: (cwd) => gauge.run(() => committingAgent(cwd)),
      },
    );

    const report = await run();

    expect(gauge.max).toBe(2);
    expect(report).toMatchObject({ taken: 5, accepted: 5, failed: 0 });
    expect(host.pullRequests).toHaveLength(5);
    for (const id of ["t-1", "t-2", "t-3", "t-4", "t-5"]) {
      expect(tracker.issue(id).status).toBe("closed");
    }
  }, 60_000);

  it("merges a spec's tasks into its integration branch one at a time, even when they finish together", async () => {
    const ids = ["s-1.1", "s-1.2", "s-1.3", "s-1.4"];
    const gauge = concurrencyGauge(ids.length);
    const agent = featureAgent();
    const { repoDir, tracker, run } = await setup(
      [
        spec({ id: "s-1" }),
        ...ids.map((id) => featureTask({ id, parent: "s-1" })),
      ],
      {
        parallel: ids.length,
        checks: [],
        agentScript: (cwd, prompt) =>
          gauge.run(() => agent.script(cwd, prompt)),
      },
    );

    const report = await run();

    expect(gauge.max).toBe(ids.length);
    expect(report).toMatchObject({ taken: 4, accepted: 4, failed: 0 });
    for (const id of ids) expect(tracker.issue(id).status).toBe("closed");
    // One merge commit per task, each on top of the one before.
    const merges = (
      await git(
        repoDir,
        "log",
        "--first-parent",
        "--merges",
        "--format=%s",
        "factory/s-1",
      )
    ).split("\n");
    expect(merges).toHaveLength(ids.length);
    expect(await subjects(repoDir, "factory/s-1")).toEqual(
      expect.arrayContaining(ids.map((id) => `Implement ${id}`)),
    );
  }, 60_000);
});
