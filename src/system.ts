import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

const isWindows = process.platform === "win32";

// Resolves a command on PATH (PATHEXT-aware on Windows); undefined when absent.
export function which(command: string): string | undefined {
  const exts = isWindows ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    for (const ext of exts) {
      const candidate = join(dir, command + ext);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {}
    }
  }
  return undefined;
}

export interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

// Runs argv to completion without blocking the event loop, so spinners keep animating.
// `inherit` hands the terminal to the child (logins, installers).
export function run(argv: readonly string[], { inherit = false } = {}): Promise<RunResult> {
  const [command, ...args] = argv;
  if (!command) throw new Error("run: empty argv");
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
      shell: isWindows, // npx / claude are .cmd shims on Windows
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk));
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk));
    child.on("error", (error) => resolve({ ok: false, stdout, stderr: error.message }));
    child.on("close", (code) => resolve({ ok: code === 0, stdout, stderr }));
  });
}

export async function runJson(argv: readonly string[]): Promise<unknown> {
  try {
    return JSON.parse((await run(argv)).stdout);
  } catch {
    return undefined;
  }
}

// Makes binaries installed during this run (uv, uv tools) visible to later steps.
export function prependPath(dir: string): void {
  if (!(process.env.PATH ?? "").split(delimiter).includes(dir)) {
    process.env.PATH = `${dir}${delimiter}${process.env.PATH ?? ""}`;
  }
}

export const UV_INSTALL: readonly string[] = isWindows
  ? ["powershell", "-ExecutionPolicy", "ByPass", "-c", "irm https://astral.sh/uv/install.ps1 | iex"]
  : ["sh", "-c", "curl -LsSf https://astral.sh/uv/install.sh | sh"];

// Where the uv installer puts `uv` by default.
export const UV_DEFAULT_BIN = join(homedir(), ".local", "bin");
