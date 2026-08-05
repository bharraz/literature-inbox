/**
 * Running the companion zot2vault program, if the user has one.
 *
 * Deliberately narrow, because this is the one genuinely risky thing the
 * plugin does and the part reviewers will look at hardest:
 *
 *  - the plugin never ships, downloads, or installs a binary. It runs exactly
 *    the path the user typed into settings, and nothing else;
 *  - the executable is passed as argv[0] with **no shell**, so a path
 *    containing spaces or shell metacharacters can't turn into command
 *    injection;
 *  - desktop only. `child_process` doesn't exist on mobile, so the caller
 *    gates on `Platform.isDesktop` and this module is imported lazily.
 *
 * The spawn itself is injected so this is testable without ever starting a
 * process — and so there is exactly one line in the codebase that launches
 * anything.
 */

export interface LaunchResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  message: string;
}

export type Spawner = (
  command: string,
  args: string[],
) => {
  stdout?: { on(event: "data", cb: (chunk: unknown) => void): void };
  stderr?: { on(event: "data", cb: (chunk: unknown) => void): void };
  on(event: "error", cb: (error: Error) => void): void;
  on(event: "close", cb: (code: number | null) => void): void;
};

/** Reject paths that clearly aren't a program before trying to run them. */
export function validateExecutablePath(path: string): string | undefined {
  const trimmed = path.trim();
  if (!trimmed) return "No zot2vault path is set. Add one in Literature Inbox settings.";
  // A shell would interpret these; we never use one, but a path containing
  // them is far more likely to be a mis-paste than a real program.
  if (/[\r\n]/.test(trimmed)) return "That path contains a line break.";
  return undefined;
}

/**
 * Run the program and collect its output.
 *
 * Never throws: a missing binary or a non-zero exit is reported as a result
 * the caller can show, because "that didn't work" is a notice, not a crash.
 */
export function runExecutable(
  executablePath: string,
  args: string[],
  spawner: Spawner,
  timeoutMs = 10 * 60 * 1000,
): Promise<LaunchResult> {
  const problem = validateExecutablePath(executablePath);
  if (problem) {
    return Promise.resolve({
      ok: false, exitCode: null, stdout: "", stderr: "", message: problem,
    });
  }

  return new Promise<LaunchResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result: LaunchResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let child: ReturnType<Spawner>;
    try {
      child = spawner(executablePath.trim(), args);
    } catch (error) {
      // Windows throws EINVAL synchronously when asked to spawn a .cmd/.bat
      // without a shell — surface it as a readable message rather than an
      // unhandled exception.
      finish({
        ok: false, exitCode: null, stdout: "", stderr: "",
        message: `Could not start that program: ${String(error)}`,
      });
      return;
    }

    const timer = setTimeout(() => {
      finish({
        ok: false, exitCode: null, stdout, stderr,
        message: "zot2vault is still running after 10 minutes — left it going in the background.",
      });
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      finish({
        ok: false, exitCode: null, stdout, stderr,
        message: `Could not start that program: ${error.message}`,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      finish({
        ok: code === 0,
        exitCode: code,
        stdout,
        stderr,
        message:
          code === 0
            ? "zot2vault finished. Run Update inbox to pick up any new papers."
            : `zot2vault exited with code ${code}. ${firstLine(stderr) || ""}`.trim(),
      });
    });
  });
}

function firstLine(text: string): string {
  return text.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "";
}
