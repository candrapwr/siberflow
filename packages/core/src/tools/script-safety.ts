interface ForbiddenScriptPattern {
  readonly name: string;
  readonly pattern: RegExp;
}

const FORBIDDEN_SCRIPT_PATTERNS: ForbiddenScriptPattern[] = [
  { name: "child_process", pattern: /\b(?:node:)?child_process\b/ },
  { name: "execSync", pattern: /\bexecSync\s*\(/ },
  { name: "execFileSync", pattern: /\bexecFileSync\s*\(/ },
  { name: "spawnSync", pattern: /\bspawnSync\s*\(/ },
  { name: "exec", pattern: /\bexec\s*\(/ },
  { name: "execFile", pattern: /\bexecFile\s*\(/ },
  { name: "spawn", pattern: /\bspawn\s*\(/ },
  { name: "fork", pattern: /\bfork\s*\(/ },
  { name: "require", pattern: /\brequire\s*\(/ },
  { name: "dynamic import", pattern: /\bimport\s*\(/ },
  { name: "process", pattern: /\bprocess\b/ },
  { name: "new Function", pattern: /\bnew\s+Function\s*\(/ },
  { name: "Function constructor", pattern: /\bFunction\s*\(/ },
  { name: "eval", pattern: /\beval\s*\(/ },
];

export function assertNoShellLikeScriptAccess(
  script: string,
  toolName: string,
): void {
  const hits = FORBIDDEN_SCRIPT_PATTERNS
    .filter(({ pattern }) => pattern.test(script))
    .map(({ name }) => name);
  if (hits.length === 0) return;

  throw new Error(
    `${toolName} blocked the script because shell/process access is not allowed here. ` +
      `Forbidden usage detected: ${[...new Set(hits)].join(", ")}. ` +
      "Remove all child_process/exec/spawn/require/import/process/eval/Function usage. " +
      "Use only the tool-provided APIs and files inside the current workdir.",
  );
}
