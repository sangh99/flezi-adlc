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
  /** Key-value data the factory keeps on the issue (see `setMetadata`). */
  readonly metadata: Readonly<Record<string, string>>;
}

export interface Tracker {
  /** Unblocked, non-epic work, in the tracker's priority order. */
  listReady(): Promise<readonly TrackerIssue[]>;
  /** Every child of `parentId` (for a spec, its tasks), in any status. */
  listChildren(parentId: string): Promise<readonly TrackerIssue[]>;
  /** Issues of `type` that aren't closed and carry every one of `labels`. */
  listLabelled(
    type: string,
    labels: readonly string[],
  ): Promise<readonly TrackerIssue[]>;
  readIssue(id: string): Promise<TrackerIssue>;
  /** Mark the issue as taken by the factory, so nobody else picks it up. */
  claim(id: string): Promise<void>;
  /**
   * Keep a claim alive while work on the issue runs. A claim the factory
   * stops renewing can be reclaimed by the tracker and taken by someone else.
   */
  heartbeat(id: string): Promise<void>;
  /** Give a claim back: the issue is open again, with no assignee. */
  release(id: string): Promise<void>;
  comment(id: string, text: string): Promise<void>;
  addLabel(id: string, label: string): Promise<void>;
  removeLabel(id: string, label: string): Promise<void>;
  /**
   * Set `key` to `value` in the issue's metadata. Keys are letters, digits,
   * `_`, `.` and `/`, starting with a letter or `_` (Beads' rule).
   */
  setMetadata(id: string, key: string, value: string): Promise<void>;
  close(id: string, reason: string): Promise<void>;
}
