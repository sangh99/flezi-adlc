import { spawn } from "node:child_process";

/**
 * Run a command on the host (never in a sandbox) and resolve with its stdout.
 * Arguments are passed without a shell. Rejects on a non-zero exit with the
 * command's stderr in the message.
 */
export const execHost = (
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly input?: string },
): Promise<string> =>
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
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else
        reject(
          new Error(
            `${command} ${args.join(" ")} exited with ${code}: ${stderr.trim() || stdout.trim()}`,
          ),
        );
    });
    child.stdin.end(options.input ?? "");
  });
