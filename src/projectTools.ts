import fs from "node:fs/promises";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveWorkspacePath } from "./fileTools.js";
import {
  runWorkspaceCommand,
  type CommandResult,
} from "./terminalTools.js";

type ToolResult = {
  structuredContent?: Record<string, unknown>;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

type CheckSpec = {
  id: string;
  ecosystem: "node" | "python" | "rust" | "go";
  label: string;
  command: string;
  args: string[];
  reason: string;
};

type CheckResult = {
  id: string;
  ecosystem: CheckSpec["ecosystem"];
  label: string;
  command: string;
  args: string[];
  ok: boolean;
  exit_code: number | null;
  duration_ms: number;
  timed_out: boolean;
  stdout: string;
  stderr: string;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  error?: string;
};

const DEFAULT_CHECK_TIMEOUT_MS = 120_000;
const MAX_CHECK_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_CHECK_OUTPUT_BYTES = 8 * 1024;
const MAX_CHECK_OUTPUT_BYTES = 256 * 1024;
const MAX_PROJECT_FILE_BYTES = 2 * 1024 * 1024;

function ok(structuredContent: Record<string, unknown>, text?: string): ToolResult {
  return {
    structuredContent,
    content: [{ type: "text", text: text ?? JSON.stringify(structuredContent, null, 2) }],
  };
}

function fail(message: string, extra: Record<string, unknown> = {}): ToolResult {
  return {
    isError: true,
    structuredContent: { ok: false, error: message, ...extra },
    content: [{ type: "text", text: message }],
  };
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function readSmallText(target: string): Promise<string | null> {
  try {
    const stat = await fs.stat(target);
    if (!stat.isFile() || stat.size > MAX_PROJECT_FILE_BYTES) return null;
    return await fs.readFile(target, "utf8");
  } catch {
    return null;
  }
}

function containsDependency(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_.-])${escaped}([^A-Za-z0-9_.-]|$)`, "i").test(text);
}

function nodeRunCommand(manager: string, script: string): { command: string; args: string[] } {
  switch (manager) {
    case "pnpm":
      return { command: "pnpm", args: ["run", script] };
    case "yarn":
      return { command: "yarn", args: ["run", script] };
    case "bun":
      return { command: "bun", args: ["run", script] };
    default:
      return { command: "npm", args: ["run", script] };
  }
}

async function detectNodeChecks(root: string): Promise<{ checks: CheckSpec[]; metadata: Record<string, unknown> | null }> {
  const packagePath = path.join(root, "package.json");
  const raw = await readSmallText(packagePath);
  if (raw === null) return { checks: [], metadata: null };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      checks: [],
      metadata: { detected: true, packageJson: true, error: "package.json is not valid JSON" },
    };
  }

  const scripts =
    typeof parsed === "object" && parsed !== null && "scripts" in parsed &&
    typeof (parsed as { scripts?: unknown }).scripts === "object" && (parsed as { scripts?: unknown }).scripts !== null
      ? (parsed as { scripts: Record<string, unknown> }).scripts
      : {};

  let manager = "npm";
  const packageManagerField =
    typeof parsed === "object" && parsed !== null && "packageManager" in parsed &&
    typeof (parsed as { packageManager?: unknown }).packageManager === "string"
      ? (parsed as { packageManager: string }).packageManager.split("@")[0].trim().toLowerCase()
      : "";
  if (["npm", "pnpm", "yarn", "bun"].includes(packageManagerField)) manager = packageManagerField;
  else if (await exists(path.join(root, "pnpm-lock.yaml"))) manager = "pnpm";
  else if (await exists(path.join(root, "yarn.lock"))) manager = "yarn";
  else if (await exists(path.join(root, "bun.lockb")) || await exists(path.join(root, "bun.lock"))) manager = "bun";

  const checks: CheckSpec[] = [];
  const candidates: Array<{ names: string[]; id: string; label: string }> = [
    { names: ["test"], id: "node:test", label: "Node tests" },
    { names: ["typecheck", "type-check", "check-types", "check:types"], id: "node:typecheck", label: "Node typecheck" },
    { names: ["build"], id: "node:build", label: "Node build" },
  ];

  for (const candidate of candidates) {
    const script = candidate.names.find((name) => typeof scripts[name] === "string" && String(scripts[name]).trim().length > 0);
    if (!script) continue;
    const invocation = nodeRunCommand(manager, script);
    checks.push({
      id: candidate.id,
      ecosystem: "node",
      label: candidate.label,
      ...invocation,
      reason: `package.json defines scripts.${script}`,
    });
  }

  return {
    checks,
    metadata: {
      detected: true,
      packageManager: manager,
      configuredScripts: Object.keys(scripts).filter((name) => typeof scripts[name] === "string"),
    },
  };
}

async function detectPythonCommand(root: string): Promise<string> {
  const candidates = process.platform === "win32"
    ? [path.join(root, ".venv", "Scripts", "python.exe"), path.join(root, "venv", "Scripts", "python.exe")]
    : [path.join(root, ".venv", "bin", "python"), path.join(root, "venv", "bin", "python")];
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  return process.platform === "win32" ? "python" : "python3";
}

async function detectPythonChecks(root: string): Promise<{ checks: CheckSpec[]; metadata: Record<string, unknown> | null }> {
  const names = ["pyproject.toml", "pytest.ini", "setup.cfg", "tox.ini", "mypy.ini", ".mypy.ini", "ruff.toml", ".ruff.toml", "requirements.txt", "requirements-dev.txt", "requirements-test.txt"];
  const entries: Record<string, string> = {};
  for (const name of names) {
    const text = await readSmallText(path.join(root, name));
    if (text !== null) entries[name] = text;
  }
  if (Object.keys(entries).length === 0) return { checks: [], metadata: null };

  const allText = Object.values(entries).join("\n");
  const pyproject = entries["pyproject.toml"] ?? "";
  const setupCfg = entries["setup.cfg"] ?? "";
  const pytestConfigured =
    "pytest.ini" in entries ||
    /\[tool\.pytest(?:\.|\])/.test(pyproject) ||
    /\[pytest\]/.test(entries["tox.ini"] ?? "") ||
    /\[tool:pytest\]/.test(setupCfg) ||
    containsDependency(allText, "pytest");
  const ruffConfigured =
    "ruff.toml" in entries || ".ruff.toml" in entries ||
    /\[tool\.ruff(?:\.|\])/.test(pyproject) ||
    containsDependency(allText, "ruff");
  const mypyConfigured =
    "mypy.ini" in entries || ".mypy.ini" in entries ||
    /\[tool\.mypy(?:\.|\])/.test(pyproject) ||
    /\[mypy(?:\.|\])/.test(setupCfg) ||
    containsDependency(allText, "mypy");

  if (!pytestConfigured && !ruffConfigured && !mypyConfigured) {
    return { checks: [], metadata: { detected: true, configuredChecks: [] } };
  }

  const python = await detectPythonCommand(root);
  const checks: CheckSpec[] = [];
  if (pytestConfigured) checks.push({
    id: "python:pytest",
    ecosystem: "python",
    label: "Python tests",
    command: python,
    args: ["-m", "pytest", "-q"],
    reason: "pytest configuration or dependency detected",
  });
  if (ruffConfigured) checks.push({
    id: "python:ruff",
    ecosystem: "python",
    label: "Python Ruff",
    command: python,
    args: ["-m", "ruff", "check", "."],
    reason: "Ruff configuration or dependency detected",
  });
  if (mypyConfigured) checks.push({
    id: "python:mypy",
    ecosystem: "python",
    label: "Python mypy",
    command: python,
    args: ["-m", "mypy", "."],
    reason: "mypy configuration or dependency detected",
  });

  return {
    checks,
    metadata: {
      detected: true,
      pythonCommand: python,
      configuredChecks: checks.map((check) => check.id),
    },
  };
}

async function detectRustChecks(root: string): Promise<{ checks: CheckSpec[]; metadata: Record<string, unknown> | null }> {
  if (!(await exists(path.join(root, "Cargo.toml")))) return { checks: [], metadata: null };
  return {
    checks: [
      { id: "rust:check", ecosystem: "rust", label: "Rust check", command: "cargo", args: ["check"], reason: "Cargo.toml detected" },
      { id: "rust:test", ecosystem: "rust", label: "Rust tests", command: "cargo", args: ["test"], reason: "Cargo.toml detected" },
    ],
    metadata: { detected: true, cargoManifest: "Cargo.toml" },
  };
}

async function detectGoChecks(root: string): Promise<{ checks: CheckSpec[]; metadata: Record<string, unknown> | null }> {
  if (!(await exists(path.join(root, "go.mod")))) return { checks: [], metadata: null };
  return {
    checks: [
      { id: "go:test", ecosystem: "go", label: "Go tests", command: "go", args: ["test", "./..."], reason: "go.mod detected" },
    ],
    metadata: { detected: true, moduleFile: "go.mod" },
  };
}

async function detectChecks(root: string): Promise<{ checks: CheckSpec[]; ecosystems: Record<string, unknown> }> {
  const [node, python, rust, go] = await Promise.all([
    detectNodeChecks(root),
    detectPythonChecks(root),
    detectRustChecks(root),
    detectGoChecks(root),
  ]);
  return {
    checks: [...node.checks, ...python.checks, ...rust.checks, ...go.checks],
    ecosystems: {
      ...(node.metadata ? { node: node.metadata } : {}),
      ...(python.metadata ? { python: python.metadata } : {}),
      ...(rust.metadata ? { rust: rust.metadata } : {}),
      ...(go.metadata ? { go: go.metadata } : {}),
    },
  };
}

function conciseResult(spec: CheckSpec, result: CommandResult): CheckResult {
  return {
    id: spec.id,
    ecosystem: spec.ecosystem,
    label: spec.label,
    command: spec.command,
    args: spec.args,
    ok: result.ok,
    exit_code: result.exit_code,
    duration_ms: result.duration_ms,
    timed_out: result.timed_out,
    stdout: result.stdout,
    stderr: result.stderr,
    stdout_truncated: result.stdout_truncated,
    stderr_truncated: result.stderr_truncated,
    ...(result.error ? { error: result.error } : {}),
  };
}

export function registerProjectTools(server: McpServer): void {
  server.registerTool(
    "check_project",
    {
      title: "Check project",
      description:
        "Detects configured project verification and runs it in one MCP call. Node runs only existing test/typecheck/build package scripts; Python runs configured pytest/ruff/mypy checks; Rust runs cargo check/test; Go runs go test ./.... Use dry_run=true to inspect the plan without executing. Commands run directly without a shell and are not sandboxed.",
      inputSchema: {
        cwd: z.string().default("."),
        mode: z.enum(["sequential", "parallel"]).default("sequential"),
        stop_on_error: z.boolean().default(false),
        dry_run: z.boolean().default(false),
        timeout_ms_per_check: z.number().int().min(1).max(MAX_CHECK_TIMEOUT_MS).default(DEFAULT_CHECK_TIMEOUT_MS),
        max_output_bytes_per_stream: z.number().int().min(1024).max(MAX_CHECK_OUTPUT_BYTES).default(DEFAULT_CHECK_OUTPUT_BYTES),
      },
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({
      cwd = ".",
      mode = "sequential",
      stop_on_error = false,
      dry_run = false,
      timeout_ms_per_check = DEFAULT_CHECK_TIMEOUT_MS,
      max_output_bytes_per_stream = DEFAULT_CHECK_OUTPUT_BYTES,
    }) => {
      try {
        const root = await resolveWorkspacePath(cwd);
        const stat = await fs.stat(root);
        if (!stat.isDirectory()) return fail(`Project cwd is not a directory: ${root}`);

        const detected = await detectChecks(root);
        const plan = detected.checks.map((check, index) => ({ index, ...check }));
        if (dry_run || detected.checks.length === 0) {
          return ok({
            ok: true,
            dryRun: dry_run,
            cwd,
            projectRoot: root,
            ecosystems: detected.ecosystems,
            planned: plan.length,
            plan,
            message: plan.length === 0 ? "No configured project checks were detected." : "Project check plan detected; nothing executed because dry_run=true.",
          });
        }

        const startedAt = Date.now();
        const results: Array<CheckResult & { index: number }> = [];

        const execute = async (spec: CheckSpec, index: number): Promise<CheckResult & { index: number }> => {
          const commandStartedAt = Date.now();
          try {
            const result = await runWorkspaceCommand({
              command: spec.command,
              args: spec.args,
              cwd,
              env: {},
              timeoutMs: timeout_ms_per_check,
              maxOutputBytes: max_output_bytes_per_stream,
            });
            return { index, ...conciseResult(spec, result) };
          } catch (err: unknown) {
            return {
              index,
              id: spec.id,
              ecosystem: spec.ecosystem,
              label: spec.label,
              command: spec.command,
              args: spec.args,
              ok: false,
              exit_code: null,
              duration_ms: Date.now() - commandStartedAt,
              timed_out: false,
              stdout: "",
              stderr: "",
              stdout_truncated: false,
              stderr_truncated: false,
              error: (err as Error).message,
            };
          }
        };

        if (mode === "parallel") {
          results.push(...await Promise.all(detected.checks.map((spec, index) => execute(spec, index))));
        } else {
          for (let index = 0; index < detected.checks.length; index += 1) {
            const result = await execute(detected.checks[index], index);
            results.push(result);
            if (stop_on_error && !result.ok) break;
          }
        }

        const skipped = detected.checks.slice(results.length).map((spec, offset) => ({
          index: results.length + offset,
          id: spec.id,
          ecosystem: spec.ecosystem,
          label: spec.label,
          reason: "Skipped because an earlier sequential check failed and stop_on_error=true.",
        }));
        const failed = results.filter((result) => !result.ok).length;
        const succeeded = results.length - failed;

        return ok({
          ok: failed === 0 && skipped.length === 0,
          cwd,
          projectRoot: root,
          ecosystems: detected.ecosystems,
          mode,
          stopOnError: stop_on_error,
          requested: detected.checks.length,
          completed: results.length,
          succeeded,
          failed,
          skipped: skipped.length,
          durationMs: Date.now() - startedAt,
          results,
          skippedChecks: skipped,
        });
      } catch (err: unknown) {
        return fail((err as Error).message);
      }
    }
  );
}
