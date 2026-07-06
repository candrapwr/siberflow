import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import type { Tool } from "../base.js";
import { resolveWithin } from "./path-utils.js";

interface Args {
  args: string[];
  timeoutMs?: number;
  maxOutputChars?: number;
}

const OPTIONS_WITH_VALUE = new Set([
  "after-context",
  "before-context",
  "binary-files",
  "context",
  "devices",
  "directories",
  "exclude",
  "exclude-dir",
  "exclude-from",
  "group-separator",
  "include",
  "label",
  "line-buffered",
  "max-count",
]);

const SHORT_OPTIONS_WITH_VALUE = new Set(["A", "B", "C", "D", "d", "m"]);
const SHORT_PATTERN_FILE_OPTIONS = new Set(["f"]);
const SHORT_PATTERN_OPTIONS = new Set(["e"]);
const LONG_PATTERN_FILE_OPTIONS = new Set(["file"]);
const LONG_PATTERN_OPTIONS = new Set(["regexp"]);
const LONG_AUX_FILE_OPTIONS = new Set(["exclude-from"]);
const LONG_FILE_VALUE_OPTIONS = new Set([...LONG_AUX_FILE_OPTIONS, ...LONG_PATTERN_FILE_OPTIONS]);

export const grepTool: Tool = {
  name: "grep",
  description:
    "Run system grep with CLI-style arguments. Pass arguments exactly as an argv array, for example {\"args\":[\"-R\",\"-n\",\"TODO\",\"src\"]}. File and directory operands, plus -f/--file pattern files, are restricted to the project directory.",
  parameters: {
    type: "object",
    properties: {
      args: {
        type: "array",
        items: { type: "string" },
        description: "Arguments passed to grep, excluding the `grep` command itself.",
      },
      timeoutMs: {
        type: "integer",
        description: "Execution timeout in milliseconds. Default 10000, max 60000.",
        minimum: 1,
        maximum: 60000,
      },
      maxOutputChars: {
        type: "integer",
        description: "Maximum stdout+stderr characters returned. Default 200000.",
        minimum: 1000,
        maximum: 200000,
      },
    },
    required: ["args"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const { args: rawArgs, timeoutMs = 10000, maxOutputChars = 200000 } = args as Args;
    if (!Array.isArray(rawArgs) || rawArgs.some((a) => typeof a !== "string")) {
      throw new Error("args must be an array of strings");
    }

    const projectReal = await realpath(ctx.projectDir);
    const grepArgs = await sandboxGrepArgs(rawArgs, projectReal);
    const cappedTimeout = Math.min(Math.max(timeoutMs, 1), 60000);
    const cappedOutput = Math.min(Math.max(maxOutputChars, 1000), 200000);

    return await runGrep(grepArgs, projectReal, cappedTimeout, cappedOutput);
  },
};

async function sandboxGrepArgs(args: string[], projectReal: string): Promise<string[]> {
  const result = [...args];
  const pathIndexes = collectPathOperandIndexes(args);

  for (let i = 0; i < result.length; i += 1) {
    const arg = result[i] ?? "";
    if (arg.startsWith("--")) {
      const { name, hasInlineValue } = splitLongOption(arg);
      if (hasInlineValue && LONG_FILE_VALUE_OPTIONS.has(name)) {
        const eq = arg.indexOf("=");
        const value = arg.slice(eq + 1);
        result[i] = `${arg.slice(0, eq + 1)}${await resolveForGrep(projectReal, value)}`;
      }
    }
  }

  for (const index of pathIndexes) {
    const value = args[index];
    if (value === undefined) continue;
    result[index] = await resolveForGrep(projectReal, value);
  }

  return result;
}

function collectPathOperandIndexes(args: string[]): Set<number> {
  const pathIndexes = new Set<number>();
  let patternProvidedByOption = false;
  let implicitPatternSeen = false;
  let endOfOptions = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";

    if (endOfOptions) {
      if (!patternProvidedByOption && !implicitPatternSeen) {
        implicitPatternSeen = true;
      } else {
        pathIndexes.add(i);
      }
      continue;
    }

    if (arg === "--") {
      endOfOptions = true;
      continue;
    }

    if (arg !== "-" && arg.startsWith("--")) {
      const { name, hasInlineValue } = splitLongOption(arg);
      if (LONG_PATTERN_OPTIONS.has(name)) {
        patternProvidedByOption = true;
        if (!hasInlineValue) i += 1;
        continue;
      }
      if (LONG_PATTERN_FILE_OPTIONS.has(name)) {
        patternProvidedByOption = true;
        if (!hasInlineValue) {
          i += 1;
          pathIndexes.add(i);
        }
        continue;
      }
      if (LONG_AUX_FILE_OPTIONS.has(name)) {
        if (!hasInlineValue) {
          i += 1;
          pathIndexes.add(i);
        }
        continue;
      }
      if (OPTIONS_WITH_VALUE.has(name) && !hasInlineValue) {
        i += 1;
      }
      continue;
    }

    if (arg !== "-" && arg.startsWith("-") && arg.length > 1) {
      const consumedNext = scanShortOptions(arg, i, args, pathIndexes);
      if (consumedNext.patternProvided) patternProvidedByOption = true;
      if (consumedNext.nextConsumed) i += 1;
      continue;
    }

    if (!patternProvidedByOption && !implicitPatternSeen) {
      implicitPatternSeen = true;
      continue;
    }
    pathIndexes.add(i);
  }

  return pathIndexes;
}

function splitLongOption(arg: string): { name: string; hasInlineValue: boolean } {
  const withoutDashes = arg.slice(2);
  const eq = withoutDashes.indexOf("=");
  if (eq === -1) return { name: withoutDashes, hasInlineValue: false };
  return { name: withoutDashes.slice(0, eq), hasInlineValue: true };
}

function scanShortOptions(
  arg: string,
  index: number,
  args: string[],
  pathIndexes: Set<number>,
): { nextConsumed: boolean; patternProvided: boolean } {
  let patternProvided = false;
  const chars = arg.slice(1);

  for (let j = 0; j < chars.length; j += 1) {
    const flag = chars[j] ?? "";
    const hasInlineValue = j < chars.length - 1;

    if (SHORT_PATTERN_OPTIONS.has(flag)) {
      patternProvided = true;
      return { nextConsumed: !hasInlineValue, patternProvided };
    }

    if (SHORT_PATTERN_FILE_OPTIONS.has(flag)) {
      patternProvided = true;
      if (!hasInlineValue) pathIndexes.add(index + 1);
      return { nextConsumed: !hasInlineValue, patternProvided };
    }

    if (SHORT_OPTIONS_WITH_VALUE.has(flag)) {
      return { nextConsumed: !hasInlineValue, patternProvided };
    }
  }

  return { nextConsumed: false, patternProvided };
}

async function resolveForGrep(projectReal: string, p: string): Promise<string> {
  const resolved = await resolveWithin(projectReal, p);
  const rel = relative(projectReal, resolved);
  if (rel === "") return ".";
  return isAbsolute(rel) ? resolved : rel;
}

function runGrep(
  args: string[],
  cwd: string,
  timeoutMs: number,
  maxOutputChars: number,
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("grep", args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1000).unref();
    }, timeoutMs);
    timer.unref();

    const append = (kind: "stdout" | "stderr", chunk: Buffer): void => {
      if (stdout.length + stderr.length >= maxOutputChars) {
        truncated = true;
        return;
      }
      const remaining = maxOutputChars - stdout.length - stderr.length;
      const text = chunk.toString("utf8").slice(0, remaining);
      if (text.length < chunk.length) truncated = true;
      if (kind === "stdout") stdout += text;
      else stderr += text;
    };

    child.stdin.end();
    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const suffix = truncated ? "\n[output truncated]" : "";
      if (timedOut) {
        reject(new Error(`grep timed out after ${timeoutMs}ms${suffix}`));
        return;
      }
      if (code === 0) {
        resolvePromise(`${stdout}${stderr ? `\n[stderr]\n${stderr}` : ""}${suffix}`);
        return;
      }
      if (code === 1) {
        resolvePromise(`No matches${stderr ? `\n[stderr]\n${stderr}` : ""}${suffix}`);
        return;
      }
      reject(new Error(`grep failed with exit ${code ?? signal}\n${stderr}${suffix}`));
    });
  });
}
