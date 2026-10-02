import { execHost } from "./host-exec.js";
import type { Tracker, TrackerIssue } from "./tracker.js";

/** The fields of a `bd ... --json` issue the factory reads. */
interface BeadsIssueJson {
  readonly id: string;
  readonly title: string;
  readonly issue_type: string;
  readonly status: string;
  readonly labels?: readonly string[];
  readonly parent?: string;
  readonly description?: string;
  readonly design?: string;
  readonly acceptance_criteria?: string;
  readonly notes?: string;
}

/**
 * Production tracker: shells out to the `bd` CLI on the host, in the repo
 * that holds the Beads database.
 */
export const beadsTracker = (options: {
  /** Directory `bd` runs in (where it discovers `.beads/`). */
  readonly cwd: string;
  /** The `bd` executable. Default: "bd". */
  readonly bin?: string;
}): Tracker => {
  const { cwd, bin = "bd" } = options;
  const bd = (args: readonly string[], input?: string) =>
    execHost(bin, args, { cwd, input });
  const bdJson = async (args: readonly string[]): Promise<unknown> =>
    JSON.parse(await bd([...args, "--json"]));

  return {
    listReady: async () => {
      const issues = await bdJson([
        "ready",
        "--exclude-type",
        "epic",
        "--limit",
        "0",
      ]);
      return (issues as BeadsIssueJson[]).map(toTrackerIssue);
    },
    listChildren: async (parentId) => {
      const issues = await bdJson([
        "list",
        "--parent",
        parentId,
        "--all",
        "--limit",
        "0",
      ]);
      return (issues as BeadsIssueJson[]).map(toTrackerIssue);
    },
    readIssue: async (id) => {
      const [issue] = (await bdJson(["show", id])) as BeadsIssueJson[];
      if (!issue) throw new Error(`bd show ${id} returned no issue`);
      return toTrackerIssue(issue);
    },
    claim: async (id) => {
      await bd(["update", id, "--claim"]);
    },
    comment: async (id, text) => {
      await bd(["comment", id, "--stdin"], text);
    },
    addLabel: async (id, label) => {
      await bd(["update", id, "--add-label", label]);
    },
    removeLabel: async (id, label) => {
      await bd(["update", id, "--remove-label", label]);
    },
    close: async (id, reason) => {
      await bd(["close", id, "--reason", reason]);
    },
  };
};

const toTrackerIssue = (issue: BeadsIssueJson): TrackerIssue => ({
  id: issue.id,
  title: issue.title,
  type: issue.issue_type,
  status: issue.status,
  labels: issue.labels ?? [],
  parent: issue.parent || undefined,
  body: issueText(issue),
});

/** The description, followed by any of Beads' other text fields. */
const issueText = (issue: BeadsIssueJson): string =>
  [
    issue.description?.trim(),
    section("Design", issue.design),
    section("Acceptance criteria", issue.acceptance_criteria),
    section("Notes", issue.notes),
  ]
    .filter((part): part is string => Boolean(part))
    .join("\n\n");

const section = (heading: string, text: string | undefined) =>
  text?.trim() ? `## ${heading}\n\n${text.trim()}` : undefined;
