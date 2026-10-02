/**
 * The factory's view of the issue tracker. Every read and write happens on
 * the host; agents in sandboxes never see this interface.
 */
export interface TrackerIssue {
  readonly id: string;
  readonly title: string;
  /** Beads issue type: "task", "bug", "epic", ... */
  readonly type: string;
  /** "open", "in_progress", "closed", ... */
  readonly status: string;
  readonly labels: readonly string[];
  /** Id of the parent issue (for a task, its spec epic), if any. */
  readonly parent?: string;
  /** The issue text the agent works from. */
  readonly body: string;
}

export interface Tracker {
  /** Unblocked, non-epic work, in the tracker's priority order. */
  listReady(): Promise<readonly TrackerIssue[]>;
  readIssue(id: string): Promise<TrackerIssue>;
  /** Mark the issue as taken by the factory, so nobody else picks it up. */
  claim(id: string): Promise<void>;
  comment(id: string, text: string): Promise<void>;
  addLabel(id: string, label: string): Promise<void>;
  removeLabel(id: string, label: string): Promise<void>;
  close(id: string, reason: string): Promise<void>;
}
