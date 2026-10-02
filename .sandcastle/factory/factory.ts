/**
 * The factory: takes approved work from the tracker, implements it in a
 * sandbox, runs the required checks itself and opens a pull request for the
 * merge gate. One call to `runFactory` is one pass over the backlog; it runs
 * to completion and returns a report.
 *
 * Only the Quick workflow is implemented: a parentless task carrying
 * `ready-for-agent`, built on its own branch cut from the base branch.
 */
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  claudeCode,
  createSandbox,
  Output,
  type AgentProvider,
  type SandboxProvider,
} from "../../src/index.js";
import { docker } from "../../src/sandboxes/docker.js";
import type { CodeHost } from "./code-host.js";
import type { Tracker, TrackerIssue } from "./tracker.js";

export const LABELS = {
  /** Task gate (or Diagnosis gate, on a bug) has been passed. */
  readyForAgent: "ready-for-agent",
  /** Added by the factory when it gives up on a piece of work. */
  factoryFailed: "factory-failed",
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

export type Workflow = "quick";

export interface TaskOutcome {
  readonly taskId: string;
  readonly workflow: Workflow;
  readonly branch: string;
  readonly status: "accepted" | "failed";
  /** What happened, for the report and the tracker. */
  readonly note: string;
  readonly pullRequestUrl?: string;
}

export interface FactoryReport {
  readonly taken: number;
  readonly accepted: number;
  readonly failed: number;
  readonly pullRequests: readonly string[];
  readonly outcomes: readonly TaskOutcome[];
}

const AgentResultSchema = z.object({
  status: z.enum(["done", "blocked"]),
  note: z.string(),
});
type AgentResult = z.infer<typeof AgentResultSchema>;

/** The structured result the implementer ends its final message with. */
export const agentResult = Output.object({
  tag: "factory-result",
  schema: AgentResultSchema,
});

const IMPLEMENT_PROMPT = fileURLToPath(
  new URL("./implement-prompt.md", import.meta.url),
);

/** Run the factory once over the backlog. */
export const runFactory = async (
  options: FactoryOptions,
): Promise<FactoryReport> => {
  const ctx = resolveOptions(options);
  const work = await findWork(ctx.tracker);
  ctx.log(`Found ${work.length} eligible task(s).`);

  // Sequential for now; a parallel limit can bound this loop later.
  const outcomes: TaskOutcome[] = [];
  for (const item of work) {
    outcomes.push(await runQuick(ctx, item.task));
  }

  const report = summarise(outcomes);
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
  ].join("\n");

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

interface WorkItem {
  readonly workflow: Workflow;
  readonly task: TrackerIssue;
}

/**
 * Pick the work the factory may take from a snapshot of the ready list.
 * Async and tracker-aware so a workflow can consult other issues (for
 * Feature, the parent spec's gate labels).
 */
const findWork = async (tracker: Tracker): Promise<WorkItem[]> => {
  const ready = await tracker.listReady();
  const work: WorkItem[] = [];
  for (const task of ready) {
    const workflow = workflowFor(task);
    if (workflow) work.push({ workflow, task });
  }
  return work;
};

const workflowFor = (task: TrackerIssue): Workflow | undefined => {
  if (
    task.type === "task" &&
    task.parent === undefined &&
    task.labels.includes(LABELS.readyForAgent)
  ) {
    return "quick";
  }
  // Feature (a task under a spec with spec-approved + ready-for-agent) and
  // Bugfix (a bug with ready-for-agent) are not implemented yet.
  return undefined;
};

// ---------------------------------------------------------------------------
// Quick workflow
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

const runQuick = async (
  ctx: Context,
  ready: TrackerIssue,
): Promise<TaskOutcome> => {
  const branch = `factory/${ready.id}`;
  const outcome = (
    status: TaskOutcome["status"],
    note: string,
    pullRequestUrl?: string,
  ): TaskOutcome => ({
    taskId: ready.id,
    workflow: "quick",
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
    const built = await build(ctx, task, branch);
    if (!built.ok) {
      await recordFailure(ctx, task.id, built.note);
      return outcome("failed", built.note);
    }

    await ctx.codeHost.pushBranch(branch);
    url = await ctx.codeHost.openPullRequest({
      branch,
      base: ctx.baseBranch,
      title: task.title,
      body: [
        `Implements Beads task \`${task.id}\`.`,
        "",
        built.note,
        "",
        `Checks passed: ${ctx.checks.map((c) => `\`${c}\``).join(", ") || "none"}.`,
      ].join("\n"),
    });
    await ctx.tracker.comment(task.id, `Factory opened a pull request: ${url}`);
    await ctx.tracker.close(task.id, `Pull request opened: ${url}`);
    return outcome("accepted", built.note, url);
  } catch (error) {
    const note = url
      ? `Pull request ${url} was opened, then the factory failed: ${messageOf(error)}`
      : `Factory error: ${messageOf(error)}`;
    await recordFailure(ctx, ready.id, note).catch(() => {});
    return outcome("failed", note, url);
  }
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

type BuildResult = { ok: true; note: string } | { ok: false; note: string };

/** Implement the task in a sandbox and run the required checks there. */
const build = async (
  ctx: Context,
  task: TrackerIssue,
  branch: string,
): Promise<BuildResult> => {
  await using sandbox = await createSandbox({
    branch,
    baseBranch: ctx.baseBranch,
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

  const run = await sandbox.run({
    name: `Implementer ${task.id}`,
    agent: ctx.agent,
    promptFile: IMPLEMENT_PROMPT,
    promptArgs: {
      TASK_ID: task.id,
      TASK_TITLE: task.title,
      TASK_BODY: task.body,
      BASE_BRANCH: ctx.baseBranch,
    },
  });

  const result = await readAgentResult(run.stdout);
  if (!result) {
    return { ok: false, note: "Agent ended without a valid result block." };
  }
  if (result.status === "blocked") {
    return { ok: false, note: `Agent reported blocked: ${result.note}` };
  }
  if (run.commits.length === 0) {
    return { ok: false, note: "Agent reported done but made no commits." };
  }

  for (const check of ctx.checks) {
    ctx.log(`  check: ${check}`);
    const { exitCode, stdout, stderr } = await sandbox.exec(check);
    if (exitCode !== 0) {
      const tail = `${stdout}\n${stderr}`.trim().split("\n").slice(-20);
      return {
        ok: false,
        note: [
          `Required check \`${check}\` failed (exit ${exitCode}).`,
          "",
          "```",
          ...tail,
          "```",
        ].join("\n"),
      };
    }
  }

  return { ok: true, note: result.note };
};

/**
 * Read the agent's result block: the last `<factory-result>` tag in its
 * output, validated against `agentResult`'s schema. `sandbox.run()` has no
 * `output` option yet, so the factory does this extraction itself.
 */
const readAgentResult = async (
  stdout: string,
): Promise<AgentResult | undefined> => {
  const { tag, schema } = agentResult;
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

const recordFailure = async (ctx: Context, id: string, note: string) => {
  ctx.log(`  failed: ${note.split("\n")[0]}`);
  await ctx.tracker.comment(
    id,
    `Factory did not open a pull request.\n\n${note}`,
  );
  await ctx.tracker.addLabel(id, LABELS.factoryFailed);
};

const summarise = (outcomes: readonly TaskOutcome[]): FactoryReport => ({
  taken: outcomes.length,
  accepted: outcomes.filter((o) => o.status === "accepted").length,
  failed: outcomes.filter((o) => o.status === "failed").length,
  pullRequests: outcomes.flatMap((o) =>
    o.pullRequestUrl ? [o.pullRequestUrl] : [],
  ),
  outcomes,
});
