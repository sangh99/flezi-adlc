/**
 * The factory: takes approved work from the tracker, implements it in a
 * sandbox, runs the required checks itself and opens a pull request for the
 * merge gate. One call to `runFactory` is one pass over the backlog; it runs
 * to completion and returns a report.
 *
 * Three workflows are implemented:
 *
 * - Quick: a parentless task carrying `ready-for-agent`, built on its own
 *   branch cut from the base branch, with its own pull request.
 * - Bugfix: a bug carrying `ready-for-agent` (the Diagnosis gate), with or
 *   without a parent. Built like a Quick task, regression test first, from
 *   the diagnosis in the bug body.
 * - Feature: a task under a spec that has passed the Spec and Task gates.
 *   Each task is built on its own branch cut from the spec's integration
 *   branch and merged back into it on the host. Once every task of the spec
 *   is closed, a reviewer agent works over the integration branch and the
 *   factory opens one pull request for the whole spec.
 *
 * The factory never writes the base branch or the host's checkout.
 */
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  claudeCode,
  createSandbox,
  Output,
  type AgentProvider,
  type OutputObjectDefinition,
  type Sandbox,
  type SandboxProvider,
} from "../../src/index.js";
import { docker } from "../../src/sandboxes/docker.js";
import type { CodeHost } from "./code-host.js";
import { ensureBranch, mergeBranch } from "./host-git.js";
import type { Tracker, TrackerIssue } from "./tracker.js";

export const LABELS = {
  /** Spec gate has been passed (on a spec). */
  specApproved: "spec-approved",
  /**
   * Task gate (on a spec, or on a Quick task) or Diagnosis gate (on a bug)
   * has been passed.
   */
  readyForAgent: "ready-for-agent",
  /** Added by the factory when it gives up on a piece of work. */
  factoryFailed: "factory-failed",
  /**
   * Added by the factory to a spec once it has opened the spec's pull
   * request, so no later run opens a second one.
   */
  prOpened: "factory-pr-opened",
} as const;

export interface FactoryOptions {
  readonly tracker: Tracker;
  readonly codeHost: CodeHost;
  /** Host repo directory. Default: `process.cwd()`. */
  readonly repoDir?: string;
  /** Branch that work is cut from and pull requests target. Default: "main". */
  readonly baseBranch?: string;
  /** Implementer agent and model. Default: `claudeCode("claude-opus-5-5")`. */
  readonly agent?: AgentProvider;
  /** Sandbox provider. Default: `docker()`. */
  readonly sandbox?: SandboxProvider;
  /**
   * Commands the factory runs in the sandbox after the agent finishes. Work
   * is accepted only if every one exits 0.
   * Default: `["npm run typecheck", "npm test"]`.
   */
  readonly checks?: readonly string[];
  /** Commands run in the sandbox once it is up. Default: `["npm install"]`. */
  readonly sandboxSetup?: readonly string[];
  /** Host paths copied into each worktree. Default: `["node_modules"]`. */
  readonly copyToWorktree?: readonly string[];
  /** Progress lines. Default: `console.log`. */
  readonly log?: (line: string) => void;
}

export type Workflow = "quick" | "feature" | "bugfix";

export interface TaskOutcome {
  readonly taskId: string;
  readonly workflow: Workflow;
  readonly branch: string;
  readonly status: "accepted" | "failed";
  /** What happened, for the report and the tracker. */
  readonly note: string;
  readonly pullRequestUrl?: string;
}

/** What happened to a spec whose tasks were all closed during the run. */
export interface SpecOutcome {
  readonly specId: string;
  /** The integration branch: the pull request's head. */
  readonly branch: string;
  readonly status: "pr-opened" | "failed";
  readonly note: string;
  readonly pullRequestUrl?: string;
}

export interface FactoryReport {
  /** Tasks taken. */
  readonly taken: number;
  readonly accepted: number;
  readonly failed: number;
  /** Every pull request opened, for Quick tasks and for specs. */
  readonly pullRequests: readonly string[];
  readonly outcomes: readonly TaskOutcome[];
  readonly specs: readonly SpecOutcome[];
}

const AgentResultSchema = z.object({
  status: z.enum(["done", "blocked"]),
  note: z.string(),
});

/** The structured result the implementer ends its final message with. */
export const agentResult = Output.object({
  tag: "factory-result",
  schema: AgentResultSchema,
});

/** The structured result the spec reviewer ends its final message with. */
export const reviewResult = Output.object({
  tag: "factory-result",
  schema: AgentResultSchema.extend({ prBody: z.string().optional() }),
});

const IMPLEMENT_PROMPT = fileURLToPath(
  new URL("./implement-prompt.md", import.meta.url),
);
const BUGFIX_PROMPT = fileURLToPath(
  new URL("./bugfix-prompt.md", import.meta.url),
);
const FEATURE_PROMPT = fileURLToPath(
  new URL("./feature-prompt.md", import.meta.url),
);
const REVIEW_PROMPT = fileURLToPath(
  new URL("./review-prompt.md", import.meta.url),
);

/** Branch a task is built on. */
const taskBranch = (taskId: string) => `factory/${taskId}`;
/** Branch a spec's accepted tasks are merged into: its pull request's head. */
const integrationBranch = (specId: string) => `factory/${specId}`;

/** Run the factory once over the backlog. */
export const runFactory = async (
  options: FactoryOptions,
): Promise<FactoryReport> => {
  const ctx = resolveOptions(options);

  // One task at a time, re-reading the ready list after each, so a task
  // unblocked by a Feature task closing earlier in the run is taken in this
  // run too. Each task is attempted at most once per run, which also bounds
  // the loop: every pass takes a task not seen before. Sequential for now;
  // a parallel limit can take a wave of the ready list here later.
  const attempted = new Set<string>();
  const outcomes: TaskOutcome[] = [];
  /** Specs that gained work this run: candidates for their pull request. */
  const landedSpecs = new Set<string>();
  for (;;) {
    const work = await findWork(ctx.tracker);
    const item = work.find((w) => !attempted.has(w.task.id));
    if (!item) break;
    attempted.add(item.task.id);
    if (item.workflow !== "feature") {
      outcomes.push(await runOwnBranch(ctx, item.workflow, item.task));
      continue;
    }
    const outcome = await runFeatureTask(ctx, item.task, item.spec);
    outcomes.push(outcome);
    if (outcome.status === "accepted") landedSpecs.add(item.spec.id);
  }

  const specs: SpecOutcome[] = [];
  for (const specId of landedSpecs) {
    const outcome = await finishSpec(ctx, specId);
    if (outcome) specs.push(outcome);
  }

  const report = summarise(outcomes, specs);
  ctx.log(formatReport(report));
  return report;
};

export const formatReport = (report: FactoryReport): string =>
  [
    "Factory run report",
    `  taken: ${report.taken}  accepted: ${report.accepted}  failed: ${report.failed}  PRs opened: ${report.pullRequests.length}`,
    ...report.outcomes.map(
      (o) =>
        `  ${o.status === "accepted" ? "+" : "x"} ${o.taskId} (${o.workflow}) ${o.pullRequestUrl ?? o.note}`,
    ),
    ...report.specs.map(
      (s) =>
        `  ${s.status === "pr-opened" ? "+" : "x"} ${s.specId} (spec) ${s.pullRequestUrl ?? s.note}`,
    ),
  ].join("\n");

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

/** Workflows whose work is built on its own branch, with its own PR. */
type OwnBranchWorkflow = "quick" | "bugfix";

type WorkItem =
  | { readonly workflow: OwnBranchWorkflow; readonly task: TrackerIssue }
  | {
      readonly workflow: "feature";
      readonly task: TrackerIssue;
      readonly spec: TrackerIssue;
    };

/**
 * Pick the work the factory may take from a snapshot of the ready list.
 * A Feature task is eligible through its parent spec's gate labels.
 */
const findWork = async (tracker: Tracker): Promise<WorkItem[]> => {
  const ready = await tracker.listReady();
  const specs = new Map<string, Promise<TrackerIssue>>();
  const readSpec = (id: string): Promise<TrackerIssue> => {
    let spec = specs.get(id);
    if (!spec) {
      spec = tracker.readIssue(id);
      specs.set(id, spec);
    }
    return spec;
  };

  const work: WorkItem[] = [];
  for (const task of ready) {
    if (task.type === "bug") {
      // A bug passes its own Diagnosis gate, so it is a Bugfix item even
      // when filed under a spec: its parent's labels don't matter.
      if (task.labels.includes(LABELS.readyForAgent)) {
        work.push({ workflow: "bugfix", task });
      }
      continue;
    }
    if (task.type !== "task") continue;
    if (task.parent === undefined) {
      if (task.labels.includes(LABELS.readyForAgent)) {
        work.push({ workflow: "quick", task });
      }
      continue;
    }
    const spec = await readSpec(task.parent);
    if (
      spec.type === "epic" &&
      spec.labels.includes(LABELS.specApproved) &&
      spec.labels.includes(LABELS.readyForAgent)
    ) {
      work.push({ workflow: "feature", task, spec });
    }
  }
  return work;
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

type Context = Required<Omit<FactoryOptions, "agent" | "sandbox">> & {
  readonly agent: AgentProvider;
  readonly sandbox: SandboxProvider;
};

const resolveOptions = (options: FactoryOptions): Context => ({
  repoDir: process.cwd(),
  baseBranch: "main",
  checks: ["npm run typecheck", "npm test"],
  sandboxSetup: ["npm install"],
  copyToWorktree: ["node_modules"],
  log: console.log,
  ...options,
  agent: options.agent ?? claudeCode("claude-opus-5-5"),
  sandbox: options.sandbox ?? docker(),
});

// ---------------------------------------------------------------------------
// Quick and Bugfix workflows
// ---------------------------------------------------------------------------

/** How a Quick task or a bug is put to the implementer and described. */
interface OwnBranchKind {
  readonly promptFile: string;
  readonly promptArgs: (
    issue: TrackerIssue,
    baseBranch: string,
  ) => Record<string, string>;
  /** The pull request body's opening lines. */
  readonly prIntro: (issue: TrackerIssue) => readonly string[];
}

const OWN_BRANCH: Record<OwnBranchWorkflow, OwnBranchKind> = {
  quick: {
    promptFile: IMPLEMENT_PROMPT,
    promptArgs: (task, baseBranch) => ({
      TASK_ID: task.id,
      TASK_TITLE: task.title,
      TASK_BODY: task.body,
      BASE_BRANCH: baseBranch,
    }),
    prIntro: (task) => [`Implements Beads task \`${task.id}\`.`],
  },
  bugfix: {
    promptFile: BUGFIX_PROMPT,
    promptArgs: (bug, baseBranch) => ({
      BUG_ID: bug.id,
      BUG_TITLE: bug.title,
      BUG_BODY: bug.body,
      BASE_BRANCH: baseBranch,
    }),
    prIntro: (bug) => {
      const rootCause = markdownSection(bug.body, "Root Cause");
      return [
        `Fixes Beads bug \`${bug.id}\`.`,
        ...(rootCause
          ? ["", "Root cause, from the diagnosis:", "", rootCause]
          : []),
      ];
    },
  },
};

/** The text under `## <heading>` in `body`, up to the next `##` heading. */
const markdownSection = (body: string, heading: string): string | undefined => {
  const lines = body.split("\n");
  const start = lines.findIndex(
    (line) => line.trim().toLowerCase() === `## ${heading.toLowerCase()}`,
  );
  if (start === -1) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{1,2} /.test(line));
  const text = (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
  return text || undefined;
};

/**
 * Build a Quick task or a bug on its own branch cut from the base branch,
 * then push it, open its pull request and close the issue.
 */
const runOwnBranch = async (
  ctx: Context,
  workflow: OwnBranchWorkflow,
  ready: TrackerIssue,
): Promise<TaskOutcome> => {
  const kind = OWN_BRANCH[workflow];
  const branch = taskBranch(ready.id);
  const outcome = (
    status: TaskOutcome["status"],
    note: string,
    pullRequestUrl?: string,
  ): TaskOutcome => ({
    taskId: ready.id,
    workflow,
    branch,
    status,
    note,
    pullRequestUrl,
  });

  ctx.log(`Taking ${ready.id}: ${ready.title} on ${branch}`);
  try {
    await ctx.tracker.claim(ready.id);
  } catch (error) {
    // Someone else may hold it: leave the task alone.
    return outcome("failed", `Could not claim: ${messageOf(error)}`);
  }

  let url: string | undefined;
  try {
    const task = await ctx.tracker.readIssue(ready.id);
    const built = await build(ctx, {
      branch,
      baseBranch: ctx.baseBranch,
      name: `Implementer ${task.id}`,
      promptFile: kind.promptFile,
      promptArgs: kind.promptArgs(task, ctx.baseBranch),
    });
    if (!built.ok) {
      await recordFailure(ctx, task.id, NO_PR, built.note);
      return outcome("failed", built.note);
    }

    await ctx.codeHost.pushBranch(branch);
    url = await ctx.codeHost.openPullRequest({
      branch,
      base: ctx.baseBranch,
      title: task.title,
      body: [...kind.prIntro(task), "", built.note, "", checksLine(ctx)].join(
        "\n",
      ),
    });
    await ctx.tracker.comment(task.id, `Factory opened a pull request: ${url}`);
    await ctx.tracker.close(task.id, `Pull request opened: ${url}`);
    return outcome("accepted", built.note, url);
  } catch (error) {
    const note = url
      ? `Pull request ${url} was opened, then the factory failed: ${messageOf(error)}`
      : `Factory error: ${messageOf(error)}`;
    await recordFailure(ctx, ready.id, NO_PR, note).catch(() => {});
    return outcome("failed", note, url);
  }
};

// ---------------------------------------------------------------------------
// Feature workflow
// ---------------------------------------------------------------------------

/** Build one task of a spec and merge it into the spec's integration branch. */
const runFeatureTask = async (
  ctx: Context,
  ready: TrackerIssue,
  spec: TrackerIssue,
): Promise<TaskOutcome> => {
  const branch = taskBranch(ready.id);
  const integration = integrationBranch(spec.id);
  const outcome = (
    status: TaskOutcome["status"],
    note: string,
  ): TaskOutcome => ({
    taskId: ready.id,
    workflow: "feature",
    branch,
    status,
    note,
  });

  ctx.log(`Taking ${ready.id}: ${ready.title} on ${branch} (spec ${spec.id})`);
  try {
    await ctx.tracker.claim(ready.id);
  } catch (error) {
    return outcome("failed", `Could not claim: ${messageOf(error)}`);
  }

  try {
    const task = await ctx.tracker.readIssue(ready.id);
    await ensureBranch(ctx.repoDir, integration, ctx.baseBranch);
    const built = await build(ctx, {
      branch,
      baseBranch: integration,
      name: `Implementer ${task.id}`,
      promptFile: FEATURE_PROMPT,
      promptArgs: {
        TASK_ID: task.id,
        TASK_TITLE: task.title,
        TASK_BODY: task.body,
        SPEC_ID: spec.id,
        SPEC_TITLE: spec.title,
        SPEC_BODY: spec.body,
        INTEGRATION_BRANCH: integration,
      },
    });
    if (!built.ok) {
      await recordFailure(ctx, task.id, NOT_MERGED, built.note);
      return outcome("failed", built.note);
    }

    const landed = await land(ctx, { task, branch, integration });
    if (!landed.ok) {
      await recordFailure(ctx, task.id, NOT_MERGED, landed.note);
      return outcome("failed", landed.note);
    }

    await ctx.tracker.close(task.id, `Merged into ${integration}`);
    return outcome("accepted", built.note);
  } catch (error) {
    const note = `Factory error: ${messageOf(error)}`;
    await recordFailure(ctx, ready.id, NOT_MERGED, note).catch(() => {});
    return outcome("failed", note);
  }
};

/**
 * Merge an accepted task branch into the integration branch on the host.
 * Merges are sequential: the caller lands one task before taking the next.
 * A conflict fails the task and leaves the integration branch where it was.
 */
const land = async (
  ctx: Context,
  job: {
    readonly task: TrackerIssue;
    readonly branch: string;
    readonly integration: string;
  },
): Promise<{ ok: true } | { ok: false; note: string }> => {
  const { task, branch, integration } = job;
  const merged = await mergeBranch(ctx.repoDir, {
    into: integration,
    from: branch,
    message: `Merge ${branch} into ${integration}\n\n${task.id}: ${task.title}`,
  });
  if (merged.ok) return { ok: true };
  // bd-ht5.4: give one merge agent a chance to resolve the conflict on the
  // task branch here, then retry the merge, before giving up.
  return {
    ok: false,
    note: [
      `Merging ${branch} into ${integration} conflicts in:`,
      ...merged.conflicts.map((file) => `- ${file}`),
      "",
      `${integration} was left as it was.`,
    ].join("\n"),
  };
};

/**
 * Once every task of the spec is closed, review the integration branch,
 * re-run the required checks and open the spec's one pull request. Does
 * nothing while a task is still open, or if the pull request was opened
 * before. Returns undefined when there was nothing to do.
 */
const finishSpec = async (
  ctx: Context,
  specId: string,
): Promise<SpecOutcome | undefined> => {
  const branch = integrationBranch(specId);
  const outcome = (
    status: SpecOutcome["status"],
    note: string,
    pullRequestUrl?: string,
  ): SpecOutcome => ({ specId, branch, status, note, pullRequestUrl });

  let url: string | undefined;
  try {
    const spec = await ctx.tracker.readIssue(specId);
    if (spec.labels.includes(LABELS.prOpened)) {
      ctx.log(`Spec ${specId} already has its pull request.`);
      return undefined;
    }
    const tasks = await ctx.tracker.listChildren(specId);
    if (tasks.length === 0 || tasks.some((t) => t.status !== "closed")) {
      return undefined;
    }

    ctx.log(`Reviewing spec ${specId} on ${branch}`);
    const reviewed = await review(ctx, spec, tasks, branch);
    if (!reviewed.ok) {
      await recordFailure(ctx, specId, NO_PR, reviewed.note);
      return outcome("failed", reviewed.note);
    }

    await ctx.codeHost.pushBranch(branch);
    url = await ctx.codeHost.openPullRequest({
      branch,
      base: ctx.baseBranch,
      title: spec.title,
      body: [
        reviewed.prBody,
        "",
        "---",
        "",
        `Implements Beads spec \`${spec.id}\`: ${spec.title}.`,
        "",
        "Tasks:",
        ...tasks.map((t) => `- \`${t.id}\`: ${t.title}`),
        "",
        checksLine(ctx),
      ].join("\n"),
    });
    // Mark first, so a failure after this point can't lead to a second PR.
    await ctx.tracker.addLabel(specId, LABELS.prOpened);
    await ctx.tracker.comment(specId, `Factory opened a pull request: ${url}`);
    return outcome("pr-opened", reviewed.note, url);
  } catch (error) {
    const note = url
      ? `Pull request ${url} was opened, then the factory failed: ${messageOf(error)}`
      : `Factory error: ${messageOf(error)}`;
    await recordFailure(ctx, specId, NO_PR, note).catch(() => {});
    return outcome("failed", note, url);
  }
};

/**
 * Run the reviewer on the integration branch, then the required checks on
 * the reviewed branch.
 */
const review = async (
  ctx: Context,
  spec: TrackerIssue,
  tasks: readonly TrackerIssue[],
  branch: string,
): Promise<{ ok: true; note: string; prBody: string } | BuildFailure> => {
  await using sandbox = await openSandbox(ctx, branch, ctx.baseBranch);
  const run = await sandbox.run({
    name: `Reviewer ${spec.id}`,
    agent: ctx.agent,
    promptFile: REVIEW_PROMPT,
    promptArgs: {
      SPEC_ID: spec.id,
      SPEC_TITLE: spec.title,
      SPEC_BODY: spec.body,
      TASK_LIST: tasks.map((t) => `- ${t.id}: ${t.title}`).join("\n"),
      BASE_BRANCH: ctx.baseBranch,
    },
  });

  const result = await readAgentResult(run.stdout, reviewResult);
  if (!result) {
    return { ok: false, note: "Reviewer ended without a valid result block." };
  }
  if (result.status === "blocked") {
    return { ok: false, note: `Reviewer reported blocked: ${result.note}` };
  }
  if (!result.prBody?.trim()) {
    return {
      ok: false,
      note: "Reviewer reported done without a pull request body.",
    };
  }

  const failed = await runChecks(ctx, sandbox);
  if (failed) return { ok: false, note: `After the review pass: ${failed}` };
  return { ok: true, note: result.note, prBody: result.prBody.trim() };
};

// ---------------------------------------------------------------------------
// Sandbox runs
// ---------------------------------------------------------------------------

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const checksLine = (ctx: Context): string =>
  `Checks passed: ${ctx.checks.map((c) => `\`${c}\``).join(", ") || "none"}.`;

type BuildFailure = { ok: false; note: string };
type BuildResult = { ok: true; note: string } | BuildFailure;

/**
 * Run the implementer in a sandbox on `branch` (cut from `baseBranch` if it
 * doesn't exist yet), then the required checks there.
 */
const build = async (
  ctx: Context,
  job: {
    readonly branch: string;
    readonly baseBranch: string;
    readonly name: string;
    readonly promptFile: string;
    readonly promptArgs: Record<string, string>;
  },
): Promise<BuildResult> => {
  await using sandbox = await openSandbox(ctx, job.branch, job.baseBranch);

  const run = await sandbox.run({
    name: job.name,
    agent: ctx.agent,
    promptFile: job.promptFile,
    promptArgs: job.promptArgs,
  });

  const result = await readAgentResult(run.stdout, agentResult);
  if (!result) {
    return { ok: false, note: "Agent ended without a valid result block." };
  }
  if (result.status === "blocked") {
    return { ok: false, note: `Agent reported blocked: ${result.note}` };
  }
  if (run.commits.length === 0) {
    return { ok: false, note: "Agent reported done but made no commits." };
  }

  const failed = await runChecks(ctx, sandbox);
  if (failed) return { ok: false, note: failed };
  return { ok: true, note: result.note };
};

/** A sandbox on `branch`, cut from `baseBranch` if it doesn't exist yet. */
const openSandbox = (ctx: Context, branch: string, baseBranch: string) =>
  createSandbox({
    branch,
    baseBranch,
    sandbox: ctx.sandbox,
    cwd: ctx.repoDir,
    copyToWorktree: [...ctx.copyToWorktree],
    hooks: {
      sandbox: {
        onSandboxReady: ctx.sandboxSetup.map((command) => ({
          command,
          timeoutMs: 15 * 60_000,
        })),
      },
    },
  });

/** Run the required checks in `sandbox`; a failure note, or undefined. */
const runChecks = async (
  ctx: Context,
  sandbox: Sandbox,
): Promise<string | undefined> => {
  for (const check of ctx.checks) {
    ctx.log(`  check: ${check}`);
    const { exitCode, stdout, stderr } = await sandbox.exec(check);
    if (exitCode !== 0) {
      const tail = `${stdout}\n${stderr}`.trim().split("\n").slice(-20);
      return [
        `Required check \`${check}\` failed (exit ${exitCode}).`,
        "",
        "```",
        ...tail,
        "```",
      ].join("\n");
    }
  }
  return undefined;
};

/**
 * Read an agent's result block: the last `output.tag` tag in its output,
 * validated against `output`'s schema. `sandbox.run()` has no `output`
 * option yet, so the factory does this extraction itself.
 */
const readAgentResult = async <T>(
  stdout: string,
  output: OutputObjectDefinition<T>,
): Promise<T | undefined> => {
  const { tag, schema } = output;
  const matches = [
    ...stdout.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g")),
  ];
  const raw = matches
    .at(-1)?.[1]
    ?.trim()
    .replace(/^```(?:json)?\s*|\s*```$/g, "");
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const validated = await schema["~standard"].validate(parsed);
  return validated.issues ? undefined : validated.value;
};

const NO_PR = "Factory did not open a pull request.";
const NOT_MERGED = "Factory did not merge this task.";

const recordFailure = async (
  ctx: Context,
  id: string,
  headline: string,
  note: string,
) => {
  ctx.log(`  failed: ${note.split("\n")[0]}`);
  await ctx.tracker.comment(id, `${headline}\n\n${note}`);
  await ctx.tracker.addLabel(id, LABELS.factoryFailed);
};

const summarise = (
  outcomes: readonly TaskOutcome[],
  specs: readonly SpecOutcome[],
): FactoryReport => ({
  taken: outcomes.length,
  accepted: outcomes.filter((o) => o.status === "accepted").length,
  failed: outcomes.filter((o) => o.status === "failed").length,
  pullRequests: [...outcomes, ...specs].flatMap((o) =>
    o.pullRequestUrl ? [o.pullRequestUrl] : [],
  ),
  outcomes,
  specs,
});
