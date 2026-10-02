import { execHost } from "./host-exec.js";

/** The factory's view of the code host. All operations run on the host. */
export interface CodeHost {
  /** Publish a local branch of the host repo. */
  pushBranch(branch: string): Promise<void>;
  /** Open a pull request and return its URL. */
  openPullRequest(request: PullRequestRequest): Promise<string>;
  /** Whether the pull request at `url` has been merged. */
  isMerged(url: string): Promise<boolean>;
}

export interface PullRequestRequest {
  /** Branch with the work (the PR head). */
  readonly branch: string;
  /** Branch the PR targets. */
  readonly base: string;
  readonly title: string;
  readonly body: string;
}

/**
 * Production code host: `git push` to a remote and the `gh` CLI for pull
 * requests, both run in the host repo.
 */
export const gitHubCodeHost = (options: {
  /** Host repo directory. */
  readonly cwd: string;
  /** Git remote to push to. Default: "origin". */
  readonly remote?: string;
}): CodeHost => {
  const { cwd, remote = "origin" } = options;
  return {
    pushBranch: async (branch) => {
      await execHost("git", ["push", remote, `${branch}:${branch}`], { cwd });
    },
    openPullRequest: async ({ branch, base, title, body }) => {
      const stdout = await execHost(
        "gh",
        [
          "pr",
          "create",
          "--head",
          branch,
          "--base",
          base,
          "--title",
          title,
          "--body-file",
          "-",
        ],
        { cwd, input: body },
      );
      const url = stdout.trim().split("\n").at(-1)?.trim();
      if (!url) throw new Error("gh pr create printed no pull request URL");
      return url;
    },
    isMerged: async (url) => {
      const stdout = await execHost(
        "gh",
        ["pr", "view", url, "--json", "state", "--jq", ".state"],
        { cwd },
      );
      return stdout.trim() === "MERGED";
    },
  };
};
