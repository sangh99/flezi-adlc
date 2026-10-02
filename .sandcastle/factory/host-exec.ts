import { spawn } from "node:child_process";

export interface HostExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Run a command on the host (never in a sandbox) and resolve with its exit
 * code and output, whatever the exit code. Arguments are passed without a
 * shell. Rejects only if the command can't start.
 */
export const spawnHost = (
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly input?: string },
): Promise<HostExecResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (error) =>
      reject(new Error(`${command} failed to start: ${error.message}`)),
    );
    child.on("close", (code) =>
      resolve({ exitCode: code ?? 1, stdout, stderr }),
    );
    child.stdin.end(options.input ?? "");
  });

/**
 * Run a command on the host (never in a sandbox) and resolve with its stdout.
 * Arguments are passed without a shell. Rejects on a non-zero exit with the
 * command's stderr in the message.
 */
export const execHost = async (
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly input?: string },
): Promise<string> => {
  const { exitCode, stdout, stderr } = await spawnHost(command, args, options);
  if (exitCode === 0) return stdout;
  throw new Error(
    `${command} ${args.join(" ")} exited with ${exitCode}: ${stderr.trim() || stdout.trim()}`,
  );
};
