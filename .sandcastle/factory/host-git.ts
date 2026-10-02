/**
 * Git operations the factory runs in the host repo. None of them touch a
 * working tree: they only write objects and move branch refs, so the host's
 * checked-out branch and files never change.
 */
import { execHost, spawnHost } from "./host-exec.js";

const git = async (
  repoDir: string,
  args: readonly string[],
  input?: string,
): Promise<string> =>
  (await execHost("git", args, { cwd: repoDir, input })).trim();

const branchSha = async (
  repoDir: string,
  branch: string,
): Promise<string | undefined> => {
  const { exitCode, stdout } = await spawnHost(
    "git",
    ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`],
    { cwd: repoDir },
  );
  return exitCode === 0 ? stdout.trim() : undefined;
};

/** Create `branch` at `from` unless it already exists. */
export const ensureBranch = async (
  repoDir: string,
  branch: string,
  from: string,
): Promise<void> => {
  if (await branchSha(repoDir, branch)) return;
  await git(repoDir, ["branch", "--no-track", branch, from]);
};

export type MergeResult =
  | { readonly ok: true; readonly sha: string }
  | { readonly ok: false; readonly conflicts: readonly string[] };

/**
 * Merge branch `from` into branch `into` with a merge commit, without a
 * working tree: `git merge-tree`, then `commit-tree`, then a compare-and-swap
 * `update-ref`. On a conflict nothing is written and `into` stays where it
 * was. Refuses to move `into` while a worktree has it checked out, since that
 * worktree's files would no longer match its branch.
 */
export const mergeBranch = async (
  repoDir: string,
  options: {
    readonly into: string;
    readonly from: string;
    readonly message: string;
  },
): Promise<MergeResult> => {
  const { into, from, message } = options;
  const checkedOut = await worktreeWithBranch(repoDir, into);
  if (checkedOut) {
    throw new Error(
      `Branch ${into} is checked out at ${checkedOut}; the factory won't merge into a checked-out branch.`,
    );
  }
  const intoSha = await branchSha(repoDir, into);
  const fromSha = await branchSha(repoDir, from);
  if (!intoSha) throw new Error(`No branch ${into} to merge into.`);
  if (!fromSha) throw new Error(`No branch ${from} to merge.`);

  const merged = await spawnHost(
    "git",
    [
      "merge-tree",
      "--write-tree",
      "--name-only",
      "--no-messages",
      intoSha,
      fromSha,
    ],
    { cwd: repoDir },
  );
  const [tree = "", ...conflicts] = merged.stdout.trim().split("\n");
  // merge-tree exits 1 on a conflict and with other codes on errors.
  if (merged.exitCode === 1) {
    return { ok: false, conflicts: conflicts.filter(Boolean) };
  }
  if (merged.exitCode !== 0) {
    throw new Error(
      `git merge-tree ${into} ${from} exited with ${merged.exitCode}: ${merged.stderr.trim()}`,
    );
  }

  const sha = await git(
    repoDir,
    ["commit-tree", tree, "-p", intoSha, "-p", fromSha, "-F", "-"],
    message,
  );
  // Compare-and-swap: fails if `into` moved since it was read.
  await git(repoDir, ["update-ref", `refs/heads/${into}`, sha, intoSha]);
  return { ok: true, sha };
};

/** Path of the worktree (main or linked) that has `branch` checked out. */
const worktreeWithBranch = async (
  repoDir: string,
  branch: string,
): Promise<string | undefined> => {
  const porcelain = await git(repoDir, ["worktree", "list", "--porcelain"]);
  for (const entry of porcelain.split("\n\n")) {
    const lines = entry.split("\n");
    if (lines.includes(`branch refs/heads/${branch}`)) {
      return lines.find((l) => l.startsWith("worktree "))?.slice(9);
    }
  }
  return undefined;
};
