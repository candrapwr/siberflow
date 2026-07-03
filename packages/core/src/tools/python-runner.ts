import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Shared Python runner. Writes `script` to a temp file and invokes
 * `python3 -u`, capturing stdout + stderr. Never throws — callers format
 * failures into the tool-result string (project convention: tools return
 * strings, they don't throw, so the agent turn survives a missing host
 * prerequisite or a Python error).
 *
 * This is the common substrate behind any tool that shells out to Python
 * (speech_to_text/text_to_speech, the pdf_script OCR path, and any future
 * Python-backed capability). Keeping it here avoids duplicating the
 * spawn/timeout/cleanup envelope across tools.
 */

/** Cap on captured stdout/stderr so a runaway process can't exhaust memory. */
const MAX_OUTPUT = 50_000;

export interface PythonResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

/**
 * Run a Python script by writing it to a temp file and invoking `python3 -u`.
 *
 * @param script   Python source to execute.
 * @param cwd      Working directory for the spawned process (typically the
 *                 session project dir so relative file I/O in the script lands
 *                 in the user's workdir).
 * @param timeoutMs Hard wall-clock cap. On expiry the process gets SIGTERM,
 *                  then SIGKILL after a 5s grace period (to drain file handles
 *                  / temp files cleanly).
 * @param env       Environment for the child. Defaults to the full parent env
 *                  so Python can find its installed packages and PATH. Pass an
 *                  explicit object to restrict it.
 */
export async function runPython(
  script: string,
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PythonResult> {
  const workDir = await mkdtemp(join(tmpdir(), "siberflow-python-"));
  const scriptPath = join(workDir, "script.py");
  await writeFile(scriptPath, script, "utf8");

  return await new Promise((resolve) => {
    const child = spawn("python3", ["-u", scriptPath], {
      cwd,
      env,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let forceKillTimer: NodeJS.Timeout | null = null;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      forceKillTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }, 5_000);
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr += chunk.toString("utf8");
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      // Best-effort temp cleanup. Don't block resolution on it.
      void rm(workDir, { recursive: true, force: true });
      resolve({ stdout, stderr, code, timedOut });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      void rm(workDir, { recursive: true, force: true });
      // spawn failure (e.g. python3 not found) surfaces here as a non-zero
      // stderr rather than a throw, so the agent turn survives.
      resolve({ stdout, stderr: stderr + err.message, code: null, timedOut: false });
    });
  });
}

/**
 * Format a Python run outcome into a tool-result string. Surfaces the exit
 * code, stdout, and stderr verbatim so the model (and ultimately the user)
 * can diagnose host-prerequisite failures such as a missing library.
 */
export function formatPythonResult(r: PythonResult): string {
  const parts: string[] = [];
  if (r.timedOut) parts.push(`(killed after timeout)`);
  parts.push(`exit code: ${r.code ?? "null"}`);
  if (r.stdout.trim()) parts.push(`--- stdout ---\n${r.stdout.trim()}`);
  if (r.stderr.trim()) parts.push(`--- stderr ---\n${r.stderr.trim()}`);
  return parts.join("\n");
}
