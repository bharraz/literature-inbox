import { describe, expect, it } from "vitest";
import { runExecutable, validateExecutablePath, type Spawner } from "../src/core/launcher";

/** A fake child process that can be driven synchronously. */
function fakeSpawner(
  behaviour: {
    stdout?: string;
    stderr?: string;
    code?: number | null;
    error?: Error;
    throwSync?: Error;
  },
  record?: { command?: string; args?: string[] },
): Spawner {
  return (command, args) => {
    if (record) {
      record.command = command;
      record.args = args;
    }
    if (behaviour.throwSync) throw behaviour.throwSync;

    const handlers: Record<string, ((value: never) => void)[]> = {};
    const emit = (event: string, value?: unknown) => {
      for (const handler of handlers[event] ?? []) handler(value as never);
    };
    const dataCallbacks: { text: string; cb: (chunk: unknown) => void }[] = [];
    const stream = (text?: string) => ({
      on(_event: "data", cb: (chunk: unknown) => void) {
        if (text) dataCallbacks.push({ text, cb });
      },
    });

    // One microtask queued at construction, so it runs after the caller has
    // synchronously registered every listener. Data is delivered before
    // close, which is the ordering Node actually guarantees — emitting close
    // first would be a fake that lies about the platform.
    queueMicrotask(() => {
      for (const { text, cb } of dataCallbacks) cb(text);
      if (behaviour.error) emit("error", behaviour.error);
      else emit("close", behaviour.code ?? 0);
    });

    return {
      stdout: stream(behaviour.stdout),
      stderr: stream(behaviour.stderr),
      on(event: string, cb: (value: never) => void) {
        (handlers[event] ??= []).push(cb);
      },
    } as ReturnType<Spawner>;
  };
}

describe("validateExecutablePath", () => {
  it("rejects an empty path with an actionable message", () => {
    expect(validateExecutablePath("")).toContain("settings");
    expect(validateExecutablePath("   ")).toContain("settings");
  });

  it("accepts an ordinary path, including one with spaces", () => {
    expect(validateExecutablePath("C:\\Program Files\\zot2vault.exe")).toBeUndefined();
    expect(validateExecutablePath("/usr/local/bin/zot2vault")).toBeUndefined();
  });

  it("rejects a path containing a line break", () => {
    expect(validateExecutablePath("/bin/a\n/bin/b")).toBeDefined();
  });
});

describe("runExecutable", () => {
  it("reports success on exit code 0", async () => {
    const result = await runExecutable("/bin/zot2vault", [], fakeSpawner({ code: 0 }));
    expect(result.ok).toBe(true);
    expect(result.message).toContain("finished");
  });

  it("passes the executable as argv[0] with no shell", async () => {
    // The injection guarantee: a path with spaces is one argument, never a
    // string handed to a shell to re-split.
    const record: { command?: string; args?: string[] } = {};
    await runExecutable(
      "C:\\Program Files\\zot2vault.exe",
      ["--vault", "My Vault"],
      fakeSpawner({ code: 0 }, record),
    );
    expect(record.command).toBe("C:\\Program Files\\zot2vault.exe");
    expect(record.args).toEqual(["--vault", "My Vault"]);
  });

  it("trims the configured path", async () => {
    const record: { command?: string } = {};
    await runExecutable("  /bin/zot2vault  ", [], fakeSpawner({ code: 0 }, record));
    expect(record.command).toBe("/bin/zot2vault");
  });

  it("reports a non-zero exit with the first line of stderr", async () => {
    const result = await runExecutable(
      "/bin/zot2vault",
      [],
      fakeSpawner({ code: 2, stderr: "no zotero.sqlite found\nstack trace here" }),
    );
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain("no zotero.sqlite found");
    expect(result.message).not.toContain("stack trace");
  });

  it("reports a missing binary rather than throwing", async () => {
    const result = await runExecutable(
      "/nope/zot2vault",
      [],
      fakeSpawner({ error: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }) }),
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Could not start");
  });

  it("survives a synchronous spawn failure", async () => {
    // Windows throws EINVAL synchronously for a .cmd spawned without a shell.
    const result = await runExecutable(
      "C:\\tools\\zot2vault.cmd",
      [],
      fakeSpawner({ throwSync: Object.assign(new Error("spawn EINVAL"), { code: "EINVAL" }) }),
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain("EINVAL");
  });

  it("refuses to run at all when no path is configured", async () => {
    let spawned = false;
    const result = await runExecutable("", [], () => {
      spawned = true;
      throw new Error("must not spawn");
    });
    expect(spawned).toBe(false);
    expect(result.ok).toBe(false);
  });

  it("collects stdout", async () => {
    const result = await runExecutable(
      "/bin/zot2vault",
      [],
      fakeSpawner({ code: 0, stdout: "wrote 12 notes" }),
    );
    expect(result.stdout).toContain("wrote 12 notes");
  });
});
