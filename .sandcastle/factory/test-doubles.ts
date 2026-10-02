/**
 * Test doubles for the factory's two ports and its sandbox provider. Used by
 * the factory's tests only.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { NoSandboxProvider } from "../../src/index.js";
import { noSandbox } from "../../src/sandboxes/no-sandbox.js";
import type { CodeHost, PullRequestRequest } from "./code-host.js";
import type { Tracker, TrackerIssue } from "./tracker.js";

const execFileAsync = promisify(execFile);

export interface InMemoryIssue {
  id: string;
  title: string;
  type: string;
  status: string;
  labels: string[];
  parent?: string;
  body: string;
  /** Ids of issues that must close before this one is ready. */
  blockedBy: string[];
  comments: string[];
  closeReason?: string;
  /** Who holds the claim, while the issue is claimed. */
  assignee?: string;
  metadata: Record<string, string>;
  /** How many times the claim's holder renewed it. */
  heartbeats: number;
}

/**
 * A tracker held in memory, with Beads' ready semantics: open, not an epic,
 * and every blocker closed. Like Beads, only a claimed issue can be renewed
 * or released.
 */
export const inMemoryTracker = (
  seed: ReadonlyArray<Partial<InMemoryIssue> & { id: string }>,
) => {
  const issues = new Map<string, InMemoryIssue>();
  /** File a new issue, as a person would between factory runs. */
  const add = (s: Partial<InMemoryIssue> & { id: string }) => {
    issues.set(s.id, {
      title: s.id,
      type: "task",
      status: "open",
      labels: [],
      body: "",
      blockedBy: [],
      comments: [],
      metadata: {},
      heartbeats: 0,
      ...s,
    });
  };
  seed.forEach(add);

  const get = (id: string): InMemoryIssue => {
    const issue = issues.get(id);
    if (!issue) throw new Error(`no issue ${id}`);
    return issue;
  };

  let heartbeatWaiters: { id: string; resolve: () => void }[] = [];
  /** Resolves on the next heartbeat on `id`. */
  const nextHeartbeat = (id: string): Promise<void> =>
    new Promise((resolve) => heartbeatWaiters.push({ id, resolve }));

  const view = (issue: InMemoryIssue): TrackerIssue => ({
    id: issue.id,
    title: issue.title,
    type: issue.type,
    status: issue.status,
    labels: [...issue.labels],
    parent: issue.parent,
    body: issue.body,
    metadata: { ...issue.metadata },
  });

  const tracker: Tracker = {
    listReady: async () =>
      [...issues.values()]
        .filter(
          (i) =>
            i.status === "open" &&
            i.type !== "epic" &&
            i.blockedBy.every((b) => get(b).status === "closed"),
        )
        .map(view),
    listChildren: async (parentId) =>
      [...issues.values()].filter((i) => i.parent === parentId).map(view),
    listLabelled: async (type, labels) =>
      [...issues.values()]
        .filter(
          (i) =>
            i.type === type &&
            i.status !== "closed" &&
            labels.every((l) => i.labels.includes(l)),
        )
        .map(view),
    readIssue: async (id) => view(get(id)),
    claim: async (id) => {
      const issue = get(id);
      issue.status = "in_progress";
      issue.assignee = "factory";
    },
    heartbeat: async (id) => {
      const issue = get(id);
      if (issue.status !== "in_progress" || !issue.assignee) {
        throw new Error(`${id} is not claimed`);
      }
      issue.heartbeats++;
      const waiting = heartbeatWaiters;
      heartbeatWaiters = waiting.filter((w) => w.id !== id);
      for (const w of waiting) if (w.id === id) w.resolve();
    },
    release: async (id) => {
      const issue = get(id);
      if (!issue.assignee) throw new Error(`${id} is not assigned`);
      issue.status = "open";
      issue.assignee = undefined;
    },
    comment: async (id, text) => {
      get(id).comments.push(text);
    },
    addLabel: async (id, label) => {
      const issue = get(id);
      if (!issue.labels.includes(label)) issue.labels.push(label);
    },
    removeLabel: async (id, label) => {
      const issue = get(id);
      issue.labels = issue.labels.filter((l) => l !== label);
    },
    setMetadata: async (id, key, value) => {
      get(id).metadata[key] = value;
    },
    close: async (id, reason) => {
      const issue = get(id);
      issue.status = "closed";
      issue.assignee = undefined;
      issue.closeReason = reason;
    },
  };

  return { tracker, issue: get, add, nextHeartbeat };
};

export interface FakePullRequest extends PullRequestRequest {
  readonly url: string;
  /** Commit the head branch pointed at when the PR was opened. */
  readonly headSha: string;
}

/**
 * A code host that "pushes" by reading the branch from the host repo and
 * records the pull requests it is asked to open. `merge` marks a pull
 * request merged, as a person at the merge gate would.
 */
export const fakeCodeHost = (repoDir: string) => {
  const pushed = new Map<string, string>();
  const pullRequests: FakePullRequest[] = [];
  const merged = new Set<string>();

  const codeHost: CodeHost = {
    pushBranch: async (branch) => {
      const { stdout } = await execFileAsync("git", ["rev-parse", branch], {
        cwd: repoDir,
      });
      pushed.set(branch, stdout.trim());
    },
    openPullRequest: async (request) => {
      const headSha = pushed.get(request.branch);
      if (!headSha) throw new Error(`branch ${request.branch} was not pushed`);
      const url = `https://example.test/pr/${pullRequests.length + 1}`;
      pullRequests.push({ ...request, url, headSha });
      return url;
    },
    isMerged: async (url) => merged.has(url),
  };

  const merge = (url: string) => {
    if (!pullRequests.some((pr) => pr.url === url)) {
      throw new Error(`no pull request ${url}`);
    }
    merged.add(url);
  };

  return { codeHost, pushed, pullRequests, merge };
};

/** Format agent text as Claude Code stream-json lines. */
const toClaudeStreamJson = (text: string): string =>
  [
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text }] },
    }),
    JSON.stringify({ type: "result", result: text }),
  ].join("\n");

/**
 * A sandbox provider that runs on the host, in the branch's git worktree,
 * whose `claude` command is replaced by `agent`, a script that receives the
 * worktree directory and the prompt, and returns the agent's final text.
 * Every other command, such as the factory's checks, runs for real there.
 *
 * Like Docker's bind mount, the agent's commits (merge commits included)
 * land in the host repo directly, with no sync step.
 */
export const scriptedSandbox = (
  agent: (cwd: string, prompt: string) => Promise<string>,
): NoSandboxProvider => {
  const base = noSandbox();
  return {
    ...base,
    name: "scripted",
    create: async (options) => {
      const handle = await base.create(options);
      return {
        ...handle,
        exec: async (command, execOptions) => {
          if (!command.startsWith("claude ")) {
            return handle.exec(command, execOptions);
          }
          const text = await agent(
            execOptions?.cwd ?? handle.worktreePath,
            execOptions?.stdin ?? "",
          );
          const stream = toClaudeStreamJson(text);
          for (const line of stream.split("\n")) execOptions?.onLine?.(line);
          return { stdout: stream, stderr: "", exitCode: 0 };
        },
      };
    },
  };
};
