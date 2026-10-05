import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async () => {
  const actual =
    await vi.importActual<typeof import("node:child_process")>(
      "node:child_process",
    );

  return {
    ...actual,
    execFile: vi.fn(),
    execFileSync: vi.fn(),
    spawn: vi.fn(),
  };
});

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { remoteDocker } from "./remote-docker.js";

const mockExecFile = vi.mocked(execFile);

/** Mock execFile so every docker call succeeds; `id` reports the given owner. */
const mockDockerOk = (owner = "1000:1000") => {
  mockExecFile.mockImplementation((_command, args, ...rest: any[]) => {
    const callback = rest[rest.length - 1];
    const isIdCall =
      Array.isArray(args) && args.some((a) => String(a).includes("id -u"));
    callback(null, isIdCall ? `${owner}\n` : "", "");
    return undefined as any;
  });
};

const dockerCalls = (): string[][] =>
  mockExecFile.mock.calls.map(([, args]) => args as string[]);

const findCall = (subcommand: string, globalArgCount = 2) =>
  dockerCalls().find((args) => args[globalArgCount] === subcommand);

afterEach(() => {
  mockExecFile.mockReset();
});

describe("remoteDocker()", () => {
  it("returns an isolated provider named 'remote-docker'", () => {
    const provider = remoteDocker({ host: "ssh://user@server" });
    expect(provider.tag).toBe("isolated");
    expect(provider.name).toBe("remote-docker");
  });

  it("throws when both host and context are set", () => {
    expect(() =>
      remoteDocker({ host: "ssh://user@server", context: "server" }),
    ).toThrow(/either `host` or `context`/);
  });

  it("passes -H <host> to every docker call", async () => {
    mockDockerOk();
    const provider = remoteDocker({
      host: "ssh://user@server",
      imageName: "sandcastle:app",
    });
    const handle = await provider.create({ env: {} });
    await handle.close();

    const calls = dockerCalls();
    expect(calls.length).toBeGreaterThan(0);
    for (const args of calls) {
      expect(args.slice(0, 2)).toEqual(["-H", "ssh://user@server"]);
    }
  });

  it("passes --context <context> when context is set", async () => {
    mockDockerOk();
    const provider = remoteDocker({
      context: "build-server",
      imageName: "sandcastle:app",
    });
    const handle = await provider.create({ env: {} });
    await handle.close();

    for (const args of dockerCalls()) {
      expect(args.slice(0, 2)).toEqual(["--context", "build-server"]);
    }
  });

  it("checks the image before docker run and does not bind-mount or set --user", async () => {
    mockDockerOk();
    const provider = remoteDocker({
      host: "ssh://user@server",
      imageName: "sandcastle:app",
      network: ["net1", "net2"],
      cpus: 2,
    });
    const handle = await provider.create({ env: { FOO: "bar" } });

    const subcommands = dockerCalls().map((args) => args[2]);
    expect(subcommands.indexOf("image")).toBeLessThan(
      subcommands.indexOf("run"),
    );

    const runArgs = findCall("run")!;
    expect(runArgs).toContain("FOO=bar");
    expect(runArgs).toContain("HOME=/home/agent");
    expect(runArgs.filter((a) => a === "--network")).toHaveLength(2);
    expect(runArgs[runArgs.indexOf("--cpus") + 1]).toBe("2");
    expect(runArgs[runArgs.length - 1]).toBe("sandcastle:app");
    expect(runArgs).not.toContain("-v");
    expect(runArgs).not.toContain("--user");
    expect(handle.worktreePath).toBe("/home/agent/workspace");

    await handle.close();
  });

  it("throws a clear error when the image is missing on the remote daemon", async () => {
    mockExecFile.mockImplementation((_command, _args, ...rest: any[]) => {
      const callback = rest[rest.length - 1];
      callback(new Error("No such image"), "", "No such image");
      return undefined as any;
    });

    const provider = remoteDocker({
      host: "ssh://user@server",
      imageName: "sandcastle:app",
    });
    await expect(provider.create({ env: {} })).rejects.toThrow(
      /Image 'sandcastle:app' not found on Docker daemon \(ssh:\/\/user@server\)/,
    );
  });

  it("copies directories by contents and chowns them to the container user", async () => {
    mockDockerOk("1000:1000");
    const dir = mkdtempSync(join(tmpdir(), "remote-docker-test-"));
    try {
      const provider = remoteDocker({
        host: "ssh://user@server",
        imageName: "sandcastle:app",
      });
      const handle = await provider.create({ env: {} });
      mockExecFile.mockClear();

      await handle.copyIn(dir, "/tmp/sync/repo");

      const cpArgs = findCall("cp")!;
      expect(cpArgs[3]).toBe(`${dir}/.`);
      expect(cpArgs[4]).toMatch(/^sandcastle-.*:\/tmp\/sync\/repo$/);

      const chownArgs = dockerCalls().find((args) => args.includes("chown"))!;
      expect(chownArgs).toContain("0:0");
      expect(chownArgs.slice(-3)).toEqual([
        "-R",
        "1000:1000",
        "/tmp/sync/repo",
      ]);

      await handle.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("copies files as-is and skips chown when the container runs as root", async () => {
    mockDockerOk("0:0");
    const dir = mkdtempSync(join(tmpdir(), "remote-docker-test-"));
    const file = join(dir, "repo.bundle");
    writeFileSync(file, "bundle");
    try {
      const provider = remoteDocker({
        host: "ssh://user@server",
        imageName: "sandcastle:app",
      });
      const handle = await provider.create({ env: {} });
      mockExecFile.mockClear();

      await handle.copyIn(file, "/tmp/sync/repo.bundle");

      expect(findCall("cp")![3]).toBe(file);
      expect(dockerCalls().some((args) => args.includes("chown"))).toBe(false);

      await handle.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("copies files out with docker cp and removes the container on close", async () => {
    mockDockerOk();
    const dir = mkdtempSync(join(tmpdir(), "remote-docker-test-"));
    try {
      const provider = remoteDocker({
        host: "ssh://user@server",
        imageName: "sandcastle:app",
      });
      const handle = await provider.create({ env: {} });
      mockExecFile.mockClear();

      const hostPath = join(dir, "nested", "out.txt");
      await handle.copyFileOut("/home/agent/workspace/out.txt", hostPath);
      const cpArgs = findCall("cp")!;
      expect(cpArgs[3]).toMatch(
        /^sandcastle-.*:\/home\/agent\/workspace\/out\.txt$/,
      );
      expect(cpArgs[4]).toBe(hostPath);

      await handle.close();
      const rmArgs = findCall("rm")!;
      expect(rmArgs[3]).toBe("-f");
      expect(rmArgs[4]).toMatch(/^sandcastle-/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
