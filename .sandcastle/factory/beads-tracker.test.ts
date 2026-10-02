import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beadsTracker } from "./beads-tracker.js";
import type { Tracker } from "./tracker.js";

const execFileAsync = promisify(execFile);

const hasBd = spawnSync("bd", ["version"]).status === 0;
if (!hasBd) {
  console.warn(
    "Skipping the Beads tracker tests: the `bd` CLI is not installed. Install it with `npm install -g @beads/bd`.",
  );
}

describe.skipIf(!hasBd)("beadsTracker against a real bd database", () => {
  let dir: string;
  let tracker: Tracker;
  const ids: Record<string, string> = {};

  /** Drive bd directly, to set up fixtures and observe the adapter's writes. */
  const bd = async (...args: string[]): Promise<string> =>
    (await execFileAsync("bd", args, { cwd: dir })).stdout.trim();
  const showJson = async (id: string) =>
    JSON.parse(await bd("show", id, "--json"))[0];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "factory-beads-"));
    await execFileAsync("git", ["init", "-b", "main"], { cwd: dir });
    await bd(
      "init",
      "--prefix",
      "t",
      "--non-interactive",
      "--skip-agents",
      "--skip-hooks",
      "-q",
    );
    ids.spec = await bd("create", "A spec", "--type", "epic", "--silent");
    ids.quick = await bd(
      "create",
      "A quick task",
      "--type",
      "task",
      "--labels",
      "ready-for-agent",
      "--description",
      "Do the thing.",
      "--acceptance",
      "- [ ] The thing is done",
      "--silent",
    );
    ids.child = await bd(
      "create",
      "A spec task",
      "--type",
      "task",
      "--parent",
      ids.spec,
      "--labels",
      "ready-for-agent",
      "--silent",
    );
    ids.closedChild = await bd(
      "create",
      "A finished spec task",
      "--type",
      "task",
      "--parent",
      ids.spec,
      "--silent",
    );
    await bd("close", ids.closedChild, "--reason", "done");
    ids.blocker = await bd("create", "A blocker", "--type", "task", "--silent");
    ids.blocked = await bd(
      "create",
      "A blocked task",
      "--type",
      "task",
      "--silent",
    );
    await bd("dep", "add", ids.blocked, "--blocked-by", ids.blocker);
    ids.held = await bd(
      "create",
      "A task to hold",
      "--type",
      "task",
      "--silent",
    );
    const epic = async (title: string, labels: string) =>
      bd("create", title, "--type", "epic", "--labels", labels, "--silent");
    ids.prSpec = await epic(
      "A spec with its PR",
      "spec-approved,ready-for-agent,factory-pr-opened",
    );
    ids.gatedSpec = await epic("A gated spec", "spec-approved,ready-for-agent");
    ids.closedPrSpec = await epic(
      "A finished spec",
      "spec-approved,ready-for-agent,factory-pr-opened",
    );
    await bd("close", ids.closedPrSpec, "--reason", "PR merged");
    ids.prTask = await bd(
      "create",
      "A task labelled like a spec",
      "--type",
      "task",
      "--labels",
      "spec-approved,ready-for-agent,factory-pr-opened",
      "--silent",
    );
    tracker = beadsTracker({ cwd: dir });
  }, 60_000);

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("lists ready work: unblocked tasks with their labels and parent, no epics", async () => {
    const ready = await tracker.listReady();
    const byId = new Map(ready.map((issue) => [issue.id, issue]));

    expect(byId.has(ids.spec!)).toBe(false);
    expect(byId.has(ids.blocked!)).toBe(false);
    expect(byId.get(ids.quick!)).toMatchObject({
      title: "A quick task",
      type: "task",
      status: "open",
      labels: ["ready-for-agent"],
      parent: undefined,
    });
    expect(byId.get(ids.child!)).toMatchObject({ parent: ids.spec });
  }, 30_000);

  it("reads an issue with its labels, parent and text", async () => {
    const child = await tracker.readIssue(ids.child!);
    expect(child).toMatchObject({
      id: ids.child,
      type: "task",
      labels: ["ready-for-agent"],
      parent: ids.spec,
    });

    const quick = await tracker.readIssue(ids.quick!);
    expect(quick.parent).toBeUndefined();
    expect(quick.body).toContain("Do the thing.");
    expect(quick.body).toContain("The thing is done");
  }, 30_000);

  it("lists every child of a spec, whatever its status", async () => {
    const children = await tracker.listChildren(ids.spec!);
    const byId = new Map(children.map((issue) => [issue.id, issue]));

    expect([...byId.keys()].sort()).toEqual(
      [ids.child!, ids.closedChild!].sort(),
    );
    expect(byId.get(ids.child!)).toMatchObject({
      status: "open",
      labels: ["ready-for-agent"],
      parent: ids.spec,
    });
    expect(byId.get(ids.closedChild!)).toMatchObject({
      status: "closed",
      parent: ids.spec,
    });
  }, 30_000);

  it("lists open issues of a type carrying every given label", async () => {
    const both = await tracker.listLabelled("epic", [
      "spec-approved",
      "ready-for-agent",
    ]);
    expect(both.map((i) => i.id).sort()).toEqual(
      [ids.prSpec!, ids.gatedSpec!].sort(),
    );

    const withPr = await tracker.listLabelled("epic", ["factory-pr-opened"]);
    expect(withPr.map((i) => i.id)).toEqual([ids.prSpec]);
    expect(withPr[0]).toMatchObject({ type: "epic", status: "open" });
  }, 30_000);

  it("keeps metadata on an issue and reads it back in reads and lists", async () => {
    await tracker.setMetadata(
      ids.prSpec!,
      "factory.pr",
      "https://example.test/pr/7",
    );
    await tracker.setMetadata(ids.prSpec!, "other", "kept");

    expect((await tracker.readIssue(ids.prSpec!)).metadata).toEqual({
      "factory.pr": "https://example.test/pr/7",
      other: "kept",
    });
    const [listed] = await tracker.listLabelled("epic", ["factory-pr-opened"]);
    expect(listed?.metadata["factory.pr"]).toBe("https://example.test/pr/7");
    expect((await tracker.readIssue(ids.gatedSpec!)).metadata).toEqual({});
  }, 30_000);

  it("renews a claim with a heartbeat, and releases it back to the ready list", async () => {
    const id = ids.held!;
    await expect(tracker.heartbeat(id)).rejects.toThrow();

    await tracker.claim(id);
    const leased = await showJson(id);
    expect(leased.lease_expires_at).toBeTruthy();
    await tracker.heartbeat(id);
    expect((await showJson(id)).status).toBe("in_progress");

    await tracker.release(id);
    const released = await showJson(id);
    expect(released.status).toBe("open");
    expect(released.assignee ?? "").toBe("");
    expect((await tracker.listReady()).map((i) => i.id)).toContain(id);
    // A released claim can't be renewed: the factory learns it lost it.
    await expect(tracker.heartbeat(id)).rejects.toThrow();
  }, 60_000);

  it("claims, comments, labels and closes", async () => {
    const id = ids.quick!;

    await tracker.claim(id);
    expect((await tracker.readIssue(id)).status).toBe("in_progress");
    expect((await tracker.listReady()).map((i) => i.id)).not.toContain(id);

    await tracker.comment(
      id,
      "Pull request opened:\nhttps://example.test/pr/1",
    );
    const comments = JSON.parse(await bd("comments", id, "--json"));
    expect(comments.map((c: { text: string }) => c.text)).toContain(
      "Pull request opened:\nhttps://example.test/pr/1",
    );

    await tracker.addLabel(id, "factory-failed");
    expect((await tracker.readIssue(id)).labels).toEqual(
      expect.arrayContaining(["factory-failed", "ready-for-agent"]),
    );
    await tracker.removeLabel(id, "factory-failed");
    expect((await tracker.readIssue(id)).labels).toEqual(["ready-for-agent"]);

    await tracker.close(id, "Pull request opened");
    expect((await tracker.readIssue(id)).status).toBe("closed");
    expect((await showJson(id)).close_reason).toBe("Pull request opened");
  }, 60_000);
});
