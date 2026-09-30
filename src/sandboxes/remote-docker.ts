/**
 * Remote Docker isolated sandbox provider — runs the sandbox container on a
 * remote Docker daemon (e.g. a Linux server reached over SSH).
 *
 * Bind mounts can't work across machines, so this is an isolated provider:
 * the repo is synced in via `docker cp` and changes are synced back out.
 *
 * Usage:
 *   import { remoteDocker } from "sandcastle/sandboxes/remote-docker";
 *   await run({
 *     agent: claudeCode("claude-opus-4-8"),
 *     sandbox: remoteDocker({ host: "ssh://user@build-server" }),
 *   });
 */

import {
  execFile,
  execFileSync,
  spawn,
  type StdioOptions,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { dirname, posix } from "node:path";
import { createInterface } from "node:readline";
import {
  createIsolatedSandboxProvider,
  type ExecResult,
  type InteractiveExecOptions,
  type IsolatedCreateOptions,
  type IsolatedSandboxHandle,
  type IsolatedSandboxProvider,
} from "../SandboxProvider.js";
import { defaultImageName } from "../mountUtils.js";
import { BoundedTail, MAX_TAIL_CHARS } from "../boundedTail.js";
import { registerShutdown } from "../shutdownRegistry.js";

/** Default worktree path inside the remote container. */
const REMOTE_REPO_PATH = "/home/agent/workspace";

export interface RemoteDockerOptions {
  /**
   * Docker daemon to connect to, passed as `docker -H <host>`
   * (e.g. `"ssh://user@build-server"` or `"tcp://10.0.0.5:2376"`).
   *
   * When neither `host` nor `context` is set, the Docker CLI's own defaults
   * apply (`DOCKER_HOST`, then the current `docker context`).
   */
  readonly host?: string;
  /**
   * Docker context to use, passed as `docker --context <context>`.
   * Mutually exclusive with `host`.
   */
  readonly context?: string;
  /**
   * Docker image name on the remote daemon
   * (default: derived from the current working directory name).
   *
   * The image must already exist on the remote daemon — build it there with
   * `DOCKER_HOST=ssh://user@build-server npx sandcastle docker build-image`.
   */
  readonly imageName?: string;
  /** Absolute path to the worktree inside the container (default: `/home/agent/workspace`). */
  readonly worktreePath?: string;
  /** Environment variables injected by this provider. Merged at launch time with env resolver and agent provider env. */
  readonly env?: Record<string, string>;
  /**
   * Docker network(s) on the remote daemon to attach the container to.
   *
   * - `"my-network"` → `--network my-network`
   * - `["net1", "net2"]` → `--network net1 --network net2`
   */
  readonly network?: string | readonly string[];
  /** Limit the CPU resources available to the container, via `--cpus`. */
  readonly cpus?: number;
  /**
   * Maximum number of characters of streamed `exec` output retained per stream
   * (stdout and stderr) when an `onLine` callback is supplied (default: 64KiB).
   */
  readonly maxOutputTailChars?: number;
}

/**
 * Create a remote Docker isolated sandbox provider.
 *
 * The returned provider starts a container on the configured Docker daemon,
 * copies the repo in with `docker cp`, and runs every command via
 * `docker exec`. Only the Docker CLI is required locally.
 */
export const remoteDocker = (
  options?: RemoteDockerOptions,
): IsolatedSandboxProvider => {
  if (options?.host && options?.context) {
    throw new Error(
      "remoteDocker(): specify either `host` or `context`, not both.",
    );
  }

  const globalArgs: string[] = options?.host
    ? ["-H", options.host]
    : options?.context
      ? ["--context", options.context]
      : [];
  const target =
    options?.host ??
    (options?.context ? `context '${options.context}'` : "default daemon");
  const maxOutputTailChars = options?.maxOutputTailChars ?? MAX_TAIL_CHARS;
  const worktreePath = options?.worktreePath ?? REMOTE_REPO_PATH;

  const dockerCmd = (args: string[]): Promise<string> =>
    new Promise((resolve, reject) => {
      execFile(
        "docker",
        [...globalArgs, ...args],
        { maxBuffer: 10 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) {
            reject(
              new Error(
                `docker ${args[0]} failed (${target}): ${stderr?.toString() || error.message}`,
              ),
            );
          } else {
            resolve((stdout ?? "").toString());
          }
        },
      );
    });

  return createIsolatedSandboxProvider({
    name: "remote-docker",
    env: options?.env,
    create: async (
      createOptions: IsolatedCreateOptions,
    ): Promise<IsolatedSandboxHandle> => {
      const containerName = `sandcastle-${randomUUID()}`;
      const imageName = options?.imageName ?? defaultImageName(process.cwd());

      // Pre-flight: the image must already exist on the remote daemon
      try {
        await dockerCmd(["image", "inspect", imageName, "--format", "{{.Id}}"]);
      } catch {
        throw new Error(
          `Image '${imageName}' not found on Docker daemon (${target}). ` +
            `Build it there first, e.g. 'DOCKER_HOST=<host> npx sandcastle docker build-image'.`,
        );
      }

      const envFlags = Object.entries({
        ...createOptions.env,
        HOME: "/home/agent",
      }).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
      const networks = options?.network
        ? Array.isArray(options.network)
          ? options.network
          : [options.network]
        : [];
      const networkFlags = networks.flatMap((n) => ["--network", n]);
      const cpusFlags =
        options?.cpus !== undefined ? ["--cpus", String(options.cpus)] : [];

      await dockerCmd([
        "run",
        "-d",
        "--name",
        containerName,
        ...envFlags,
        ...networkFlags,
        ...cpusFlags,
        imageName,
      ]);

      const removeContainerSync = () => {
        try {
          execFileSync("docker", [...globalArgs, "rm", "-f", containerName], {
            stdio: "ignore",
          });
        } catch {
          /* best-effort */
        }
      };
      const unregisterShutdown = registerShutdown(removeContainerSync);

      let owner: string;
      try {
        // Files copied in with `docker cp` are owned by root; remember the
        // container user so copyIn can hand them back.
        owner = (
          await dockerCmd([
            "exec",
            containerName,
            "sh",
            "-c",
            'echo "$(id -u):$(id -g)"',
          ])
        ).trim();
        await dockerCmd(["exec", containerName, "mkdir", "-p", worktreePath]);
      } catch (error) {
        unregisterShutdown();
        removeContainerSync();
        throw error;
      }

      const handle: IsolatedSandboxHandle = {
        worktreePath,

        exec: (
          command: string,
          opts?: {
            onLine?: (line: string) => void;
            cwd?: string;
            sudo?: boolean;
            stdin?: string;
          },
        ): Promise<ExecResult> => {
          const effectiveCommand = opts?.sudo ? `sudo ${command}` : command;
          const args = [...globalArgs, "exec"];
          if (opts?.stdin !== undefined) args.push("-i");
          if (opts?.cwd) args.push("-w", opts.cwd);
          args.push(containerName, "sh", "-c", effectiveCommand);

          return new Promise((resolve, reject) => {
            const proc = spawn("docker", args, {
              stdio: [
                opts?.stdin !== undefined ? "pipe" : "ignore",
                "pipe",
                "pipe",
              ],
            });

            if (opts?.stdin !== undefined) {
              proc.stdin!.write(opts.stdin);
              proc.stdin!.end();
            }

            proc.on("error", (error) => {
              reject(new Error(`docker exec failed: ${error.message}`));
            });

            if (opts?.onLine) {
              const onLine = opts.onLine;
              const stdoutTail = new BoundedTail(maxOutputTailChars, "\n");
              const stderrTail = new BoundedTail(maxOutputTailChars, "");
              const rl = createInterface({ input: proc.stdout! });
              rl.on("line", (line) => {
                stdoutTail.push(line);
                onLine(line);
              });
              proc.stderr!.on("data", (chunk: Buffer) => {
                stderrTail.push(chunk.toString());
              });
              proc.on("close", (code) => {
                resolve({
                  stdout: stdoutTail.toString(),
                  stderr: stderrTail.toString(),
                  exitCode: code ?? 0,
                });
              });
            } else {
              const stdoutChunks: string[] = [];
              const stderrChunks: string[] = [];
              proc.stdout!.on("data", (chunk: Buffer) => {
                stdoutChunks.push(chunk.toString());
              });
              proc.stderr!.on("data", (chunk: Buffer) => {
                stderrChunks.push(chunk.toString());
              });
              proc.on("close", (code) => {
                resolve({
                  stdout: stdoutChunks.join(""),
                  stderr: stderrChunks.join(""),
                  exitCode: code ?? 0,
                });
              });
            }
          });
        },

        interactiveExec: (
          args: string[],
          opts: InteractiveExecOptions,
        ): Promise<{ exitCode: number }> => {
          return new Promise((resolve, reject) => {
            const dockerArgs = [...globalArgs, "exec"];
            // Allocate a pseudo-terminal when stdin looks like a TTY
            if (
              "isTTY" in opts.stdin &&
              (opts.stdin as { isTTY?: boolean }).isTTY
            ) {
              dockerArgs.push("-it");
            } else {
              dockerArgs.push("-i");
            }
            if (opts.cwd) dockerArgs.push("-w", opts.cwd);
            dockerArgs.push(containerName, ...args);

            const proc = spawn("docker", dockerArgs, {
              stdio: [opts.stdin, opts.stdout, opts.stderr] as StdioOptions,
            });

            proc.on("error", (error: Error) => {
              reject(new Error(`docker exec failed: ${error.message}`));
            });

            proc.on("close", (code: number | null) => {
              resolve({ exitCode: code ?? 0 });
            });
          });
        },

        copyIn: async (
          hostPath: string,
          sandboxPath: string,
        ): Promise<void> => {
          const info = await stat(hostPath);
          await dockerCmd([
            "exec",
            containerName,
            "mkdir",
            "-p",
            posix.dirname(sandboxPath),
          ]);
          // A trailing "/." copies the directory's contents, so sandboxPath
          // becomes the copy whether or not it already exists.
          const source = info.isDirectory() ? `${hostPath}/.` : hostPath;
          await dockerCmd(["cp", source, `${containerName}:${sandboxPath}`]);
          if (owner !== "0:0") {
            await dockerCmd([
              "exec",
              "--user",
              "0:0",
              containerName,
              "chown",
              "-R",
              owner,
              sandboxPath,
            ]);
          }
        },

        copyFileOut: async (
          sandboxPath: string,
          hostPath: string,
        ): Promise<void> => {
          await mkdir(dirname(hostPath), { recursive: true });
          await dockerCmd(["cp", `${containerName}:${sandboxPath}`, hostPath]);
        },

        close: async (): Promise<void> => {
          unregisterShutdown();
          await dockerCmd(["rm", "-f", containerName]).catch(() => {});
        },
      };

      return handle;
    },
  });
};
