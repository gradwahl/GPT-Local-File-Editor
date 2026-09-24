import { randomUUID } from "node:crypto";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import spawn from "cross-spawn";
import fs from "node:fs/promises";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getActiveWorkspaceRoot, resolveWorkspacePath } from "./fileTools.js";

type ToolResult = {
  structuredContent?: Record<string, unknown>;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export type RunCommandOptions = {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdin?: string;
  timeoutMs: number;
  maxOutputBytes: number;
};

export type CommandResult = {
  ok: boolean;
  command: string;
  args: string[];
  cwd: string;
  pid: number | null;
  exitCode: number | null;
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  timed_out: boolean;
  durationMs: number;
  duration_ms: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  stdout_bytes: number;
  stderr_bytes: number;
  stdoutRetainedBytes: number;
  stderrRetainedBytes: number;
  stdout_retained_bytes: number;
  stderr_retained_bytes: number;
  stdoutOmittedBytes: number;
  stderrOmittedBytes: number;
  stdout_omitted_bytes: number;
  stderr_omitted_bytes: number;
  maxOutputBytes: number;
  max_output_bytes: number;
  error?: string;
};

type ProcessStatus = "running" | "stopping" | "exited" | "failed";

type ManagedProcess = {
  id: string;
  child: ChildProcessWithoutNullStreams;
  command: string;
  args: string[];
  cwd: string;
  startedAt: number;
  exitedAt: number | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  status: ProcessStatus;
  error: string | null;
  stdinClosed: boolean;
  stopRequestedAt: number | null;
  stdout: UnreadBuffer;
  stderr: UnreadBuffer;
};

const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const FALLBACK_COMMAND_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_PROCESS_BUFFER_BYTES = 1024 * 1024;
const DEFAULT_PROCESS_READ_BYTES = 64 * 1024;
const MAX_COMMAND_TIMEOUT_MS = 30 * 60_000;
const MAX_COMMAND_OUTPUT_BYTES = 10 * 1024 * 1024;

export function defaultCommandOutputBytes(): number {
  const raw = process.env.COMMAND_MAX_OUTPUT_BYTES?.trim();
  if (!raw) return FALLBACK_COMMAND_OUTPUT_BYTES;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > MAX_COMMAND_OUTPUT_BYTES) {
    return FALLBACK_COMMAND_OUTPUT_BYTES;
  }
  return parsed;
}
const MAX_PROCESS_BUFFER_BYTES = 20 * 1024 * 1024;
const MAX_MANAGED_PROCESSES = 100;
const MAX_PROCESS_READ_WAIT_MS = 30_000;
const DEFAULT_STOP_GRACE_MS = 3_000;
const MAX_STOP_GRACE_MS = 30_000;

const processes = new Map<string, ManagedProcess>();

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

class AnsiStripper {
  private state: "text" | "escape" | "csi" | "osc" | "oscEscape" | "string" | "stringEscape" = "text";

  push(chunk: Buffer | string): Buffer {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (data.length === 0) return Buffer.alloc(0);

    const output = Buffer.allocUnsafe(data.length);
    let outputLength = 0;

    for (const byte of data) {
      switch (this.state) {
        case "text":
          if (byte === 0x1b) {
            this.state = "escape";
          } else {
            output[outputLength++] = byte;
          }
          break;

        case "escape":
          if (byte === 0x5b) {
            // CSI: ESC [ ... final byte
            this.state = "csi";
          } else if (byte === 0x5d) {
            // OSC: ESC ] ... BEL or ST
            this.state = "osc";
          } else if (byte === 0x50 || byte === 0x58 || byte === 0x5e || byte === 0x5f) {
            // DCS / SOS / PM / APC: terminated by ST (ESC \).
            this.state = "string";
          } else if (byte === 0x1b) {
            // A new ESC restarts the escape sequence.
            this.state = "escape";
          } else if (byte >= 0x30 && byte <= 0x7e) {
            // Final byte of a short ANSI escape sequence.
            this.state = "text";
          } else if (byte >= 0x20 && byte <= 0x2f) {
            // Intermediate byte; remain in the escape state.
          } else {
            // Malformed escape: discard it rather than leaking control bytes.
            this.state = "text";
          }
          break;

        case "csi":
          if (byte === 0x1b) {
            this.state = "escape";
          } else if (byte >= 0x40 && byte <= 0x7e) {
            this.state = "text";
          }
          break;

        case "osc":
          if (byte === 0x07) {
            this.state = "text";
          } else if (byte === 0x1b) {
            this.state = "oscEscape";
          }
          break;

        case "oscEscape":
          if (byte === 0x5c) {
            this.state = "text";
          } else if (byte === 0x1b) {
            this.state = "oscEscape";
          } else {
            this.state = "osc";
          }
          break;

        case "string":
          if (byte === 0x1b) this.state = "stringEscape";
          break;

        case "stringEscape":
          if (byte === 0x5c) {
            this.state = "text";
          } else if (byte === 0x1b) {
            this.state = "stringEscape";
          } else {
            this.state = "string";
          }
          break;
      }
    }

    return output.subarray(0, outputLength);
  }
}

class HeadTailBuffer {
  private readonly ansiStripper = new AnsiStripper();
  private readonly headLimit: number;
  private readonly markerReserve: number;
  private tailLimit: number;
  private overflowMode = false;
  private head = Buffer.alloc(0);
  private tail: Buffer = Buffer.alloc(0);
  private totalBytes = 0;

  constructor(private readonly maxBytes: number) {
    this.markerReserve = Math.min(8 * 1024, Math.max(128, Math.floor(maxBytes / 8)));
    this.headLimit = Math.min(8 * 1024, Math.floor(maxBytes / 4));
    // Until the stream actually exceeds maxBytes, keep enough tail capacity to
    // preserve every byte. Once it overflows, switch to the head+tail layout
    // and reserve room for the inserted truncation marker.
    this.tailLimit = Math.max(0, maxBytes - this.headLimit);
  }

  push(chunk: Buffer | string): void {
    const data = this.ansiStripper.push(chunk);
    if (data.length === 0) return;
    this.totalBytes += data.length;
    if (!this.overflowMode && this.totalBytes > this.maxBytes) {
      this.overflowMode = true;
      this.tailLimit = Math.max(0, this.maxBytes - this.headLimit - this.markerReserve);
      if (this.tail.length > this.tailLimit) {
        this.tail = this.tail.subarray(this.tail.length - this.tailLimit);
      }
    }

    if (this.head.length < this.headLimit) {
      const take = Math.min(this.headLimit - this.head.length, data.length);
      this.head = Buffer.concat([this.head, data.subarray(0, take)]);
      if (take === data.length) return;
      this.pushTail(data.subarray(take));
      return;
    }

    this.pushTail(data);
  }

  private pushTail(data: Buffer): void {
    if (this.tailLimit === 0 || data.length === 0) return;
    if (data.length >= this.tailLimit) {
      this.tail = data.subarray(data.length - this.tailLimit);
      return;
    }

    this.tail = Buffer.concat([this.tail, data]);
    if (this.tail.length > this.tailLimit) {
      this.tail = this.tail.subarray(this.tail.length - this.tailLimit);
    }
  }

  snapshot(): { text: string; truncated: boolean; totalBytes: number; retainedBytes: number; omittedBytes: number } {
    const retainedBytes = this.head.length + this.tail.length;
    const omittedBytes = Math.max(0, this.totalBytes - retainedBytes);
    const truncated = omittedBytes > 0;
    if (!truncated) {
      return {
        text: Buffer.concat([this.head, this.tail]).toString("utf8"),
        truncated: false,
        totalBytes: this.totalBytes,
        retainedBytes,
        omittedBytes: 0,
      };
    }

    const marker = Buffer.from(`\n... [${omittedBytes} bytes truncated; showing head + tail] ...\n`);
    return {
      text: Buffer.concat([this.head, marker, this.tail]).toString("utf8"),
      truncated: true,
      totalBytes: this.totalBytes,
      retainedBytes,
      omittedBytes,
    };
  }
}

class UnreadBuffer {
  private readonly ansiStripper = new AnsiStripper();
  private chunks: Buffer[] = [];
  private bytes = 0;
  private droppedBytes = 0;

  constructor(private readonly maxBytes: number) {}

  push(chunk: Buffer | string): void {
    let data = this.ansiStripper.push(chunk);
    if (data.length === 0) return;

    if (data.length >= this.maxBytes) {
      this.droppedBytes += this.bytes + data.length - this.maxBytes;
      this.chunks = [data.subarray(data.length - this.maxBytes)];
      this.bytes = this.maxBytes;
      return;
    }

    this.chunks.push(data);
    this.bytes += data.length;
    while (this.bytes > this.maxBytes && this.chunks.length > 0) {
      const overflow = this.bytes - this.maxBytes;
      const first = this.chunks[0];
      if (first.length <= overflow) {
        this.chunks.shift();
        this.bytes -= first.length;
        this.droppedBytes += first.length;
      } else {
        this.chunks[0] = first.subarray(overflow);
        this.bytes -= overflow;
        this.droppedBytes += overflow;
      }
    }
  }

  drain(maxBytes: number): { text: string; bytes: number; remainingBytes: number; droppedBytes: number } {
    const takeBytes = Math.min(Math.max(0, maxBytes), this.bytes);
    if (takeBytes === 0) {
      const droppedBytes = this.droppedBytes;
      this.droppedBytes = 0;
      return { text: "", bytes: 0, remainingBytes: this.bytes, droppedBytes };
    }

    const output: Buffer[] = [];
    let remaining = takeBytes;
    while (remaining > 0 && this.chunks.length > 0) {
      const first = this.chunks[0];
      if (first.length <= remaining) {
        output.push(first);
        this.chunks.shift();
        this.bytes -= first.length;
        remaining -= first.length;
      } else {
        output.push(first.subarray(0, remaining));
        this.chunks[0] = first.subarray(remaining);
        this.bytes -= remaining;
        remaining = 0;
      }
    }

    const droppedBytes = this.droppedBytes;
    this.droppedBytes = 0;
    return {
      text: Buffer.concat(output).toString("utf8"),
      bytes: takeBytes,
      remainingBytes: this.bytes,
      droppedBytes,
    };
  }

  get unreadBytes(): number {
    return this.bytes;
  }

  get dropped(): number {
    return this.droppedBytes;
  }
}

async function resolveCommandCwd(relativeCwd: string): Promise<string> {
  const cwd = await resolveWorkspacePath(relativeCwd || ".");
  const stat = await fs.stat(cwd);
  if (!stat.isDirectory()) throw new Error(`Command cwd is not a directory: ${cwd}`);
  return cwd;
}

function childEnvironment(overrides: Record<string, string>, cwd: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...overrides };
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const existingPath = env[pathKey] ?? "";
  const localBin = path.join(cwd, "node_modules", ".bin");
  env[pathKey] = existingPath ? `${localBin}${path.delimiter}${existingPath}` : localBin;
  return env;
}

function validateCommand(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) throw new Error("command must not be empty.");
  if (trimmed.includes("\0")) throw new Error("command contains an invalid NUL byte.");
  return trimmed;
}

function spawnProcess(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv
): ChildProcessWithoutNullStreams {
  // cross-spawn preserves direct executable + argv semantics while fixing
  // Windows PATHEXT, shebang, and .cmd/.bat shim resolution. Do not set
  // shell:true here: run_command is intentionally the fast direct executor.
  return spawn(command, args, {
    cwd,
    env,
    shell: false,
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
}

async function signalProcessTree(child: ChildProcessWithoutNullStreams, force: boolean): Promise<void> {
  if (!child.pid) return;

  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const args = ["/PID", String(child.pid), "/T"];
      if (force) args.push("/F");
      const killer = spawn("taskkill", args, {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.once("error", () => {
        try {
          child.kill();
        } catch {
          // Process may already be gone.
        }
        resolve();
      });
      killer.once("close", () => resolve());
    });
    return;
  }

  try {
    process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
  } catch {
    try {
      child.kill(force ? "SIGKILL" : "SIGTERM");
    } catch {
      // Process may already be gone.
    }
  }
}

async function killProcessTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  await signalProcessTree(child, true);
}

export async function runWorkspaceCommand(options: RunCommandOptions): Promise<CommandResult> {
  const command = validateCommand(options.command);
  const cwd = await resolveCommandCwd(options.cwd);
  const stdout = new HeadTailBuffer(options.maxOutputBytes);
  const stderr = new HeadTailBuffer(options.maxOutputBytes);
  const startedAt = Date.now();

  return await new Promise<CommandResult>((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    let timedOut = false;
    let spawnError: string | undefined;
    let settled = false;
    let timer: NodeJS.Timeout | null = null;

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const stdoutResult = stdout.snapshot();
      const stderrResult = stderr.snapshot();
      const durationMs = Date.now() - startedAt;
      resolve({
        ok: !spawnError && !timedOut && exitCode === 0,
        command,
        args: options.args,
        cwd,
        pid: child?.pid ?? null,
        exitCode,
        exit_code: exitCode,
        signal,
        timedOut,
        timed_out: timedOut,
        durationMs,
        duration_ms: durationMs,
        stdout: stdoutResult.text,
        stderr: stderrResult.text,
        stdoutTruncated: stdoutResult.truncated,
        stderrTruncated: stderrResult.truncated,
        stdout_truncated: stdoutResult.truncated,
        stderr_truncated: stderrResult.truncated,
        stdoutBytes: stdoutResult.totalBytes,
        stderrBytes: stderrResult.totalBytes,
        stdout_bytes: stdoutResult.totalBytes,
        stderr_bytes: stderrResult.totalBytes,
        stdoutRetainedBytes: stdoutResult.retainedBytes,
        stderrRetainedBytes: stderrResult.retainedBytes,
        stdout_retained_bytes: stdoutResult.retainedBytes,
        stderr_retained_bytes: stderrResult.retainedBytes,
        stdoutOmittedBytes: stdoutResult.omittedBytes,
        stderrOmittedBytes: stderrResult.omittedBytes,
        stdout_omitted_bytes: stdoutResult.omittedBytes,
        stderr_omitted_bytes: stderrResult.omittedBytes,
        maxOutputBytes: options.maxOutputBytes,
        max_output_bytes: options.maxOutputBytes,
        ...(spawnError ? { error: spawnError } : {}),
      });
    };

    try {
      child = spawnProcess(command, options.args, cwd, childEnvironment(options.env, cwd));
    } catch (err: unknown) {
      spawnError = (err as Error).message;
      finish(null, null);
      return;
    }

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (err) => {
      spawnError = err.message;
      finish(null, null);
    });
    child.once("close", (code, signal) => finish(code, signal));

    if (options.stdin !== undefined) {
      child.stdin.end(options.stdin);
    } else {
      child.stdin.end();
    }

    timer = setTimeout(() => {
      timedOut = true;
      void killProcessTree(child).finally(() => {
        setTimeout(() => finish(null, null), 2_000).unref();
      });
    }, options.timeoutMs);
    timer.unref();
  });
}

function processSummary(proc: ManagedProcess): Record<string, unknown> {
  return {
    process_id: proc.id,
    pid: proc.child.pid ?? null,
    command: proc.command,
    args: proc.args,
    cwd: proc.cwd,
    status: proc.status,
    exitCode: proc.exitCode,
    signal: proc.signal,
    error: proc.error,
    stdinClosed: proc.stdinClosed,
    startedAt: new Date(proc.startedAt).toISOString(),
    exitedAt: proc.exitedAt ? new Date(proc.exitedAt).toISOString() : null,
    stopRequestedAt: proc.stopRequestedAt ? new Date(proc.stopRequestedAt).toISOString() : null,
    stdoutUnreadBytes: proc.stdout.unreadBytes,
    stderrUnreadBytes: proc.stderr.unreadBytes,
    stdoutDroppedBytes: proc.stdout.dropped,
    stderrDroppedBytes: proc.stderr.dropped,
  };
}

function processIsActive(proc: ManagedProcess): boolean {
  return proc.status === "running" || proc.status === "stopping";
}

async function waitForManagedProcessExit(proc: ManagedProcess, timeoutMs: number): Promise<boolean> {
  if (!processIsActive(proc)) return true;
  if (timeoutMs <= 0) return false;

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (exited: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.child.off("close", onClose);
      resolve(exited);
    };
    const onClose = (): void => finish(true);
    const timer = setTimeout(() => finish(!processIsActive(proc)), timeoutMs);
    timer.unref();
    proc.child.once("close", onClose);
  });
}

async function waitForProcessOutput(proc: ManagedProcess, timeoutMs: number): Promise<void> {
  if (timeoutMs <= 0 || proc.stdout.unreadBytes > 0 || proc.stderr.unreadBytes > 0 || !processIsActive(proc)) return;

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.child.stdout.off("data", onData);
      proc.child.stderr.off("data", onData);
      proc.child.off("close", onClose);
      proc.child.off("error", onClose);
      resolve();
    };
    const onData = (): void => finish();
    const onClose = (): void => finish();
    const timer = setTimeout(finish, timeoutMs);
    timer.unref();
    proc.child.stdout.once("data", onData);
    proc.child.stderr.once("data", onData);
    proc.child.once("close", onClose);
    proc.child.once("error", onClose);
  });
}

function pruneProcesses(): void {
  if (processes.size < MAX_MANAGED_PROCESSES) return;
  const exited = [...processes.values()]
    .filter((proc) => proc.status !== "running")
    .sort((a, b) => (a.exitedAt ?? a.startedAt) - (b.exitedAt ?? b.startedAt));

  while (processes.size >= MAX_MANAGED_PROCESSES && exited.length > 0) {
    const proc = exited.shift();
    if (proc) processes.delete(proc.id);
  }
}

async function startManagedProcess(options: {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdin?: string;
  maxBufferBytes: number;
}): Promise<ManagedProcess> {
  pruneProcesses();
  if (processes.size >= MAX_MANAGED_PROCESSES) {
    throw new Error(`Too many managed processes. Stop or allow existing processes to exit before starting more (limit ${MAX_MANAGED_PROCESSES}).`);
  }

  const command = validateCommand(options.command);
  const cwd = await resolveCommandCwd(options.cwd);
  const child = spawnProcess(command, options.args, cwd, childEnvironment(options.env, cwd));
  const id = `proc_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const proc: ManagedProcess = {
    id,
    child,
    command,
    args: options.args,
    cwd,
    startedAt: Date.now(),
    exitedAt: null,
    exitCode: null,
    signal: null,
    status: "running",
    error: null,
    stdinClosed: false,
    stopRequestedAt: null,
    stdout: new UnreadBuffer(options.maxBufferBytes),
    stderr: new UnreadBuffer(options.maxBufferBytes),
  };

  child.stdout.on("data", (chunk: Buffer) => proc.stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => proc.stderr.push(chunk));
  child.once("error", (err) => {
    proc.error = err.message;
    proc.status = "failed";
    proc.exitedAt = Date.now();
  });
  child.once("close", (code, signal) => {
    proc.exitCode = code;
    proc.signal = signal;
    proc.status = proc.error ? "failed" : "exited";
    proc.exitedAt = Date.now();
  });
  child.stdin.once("finish", () => {
    proc.stdinClosed = true;
  });

  // Do not hand out a process_id until the executable has actually spawned.
  // This avoids returning status="running" for a missing executable whose
  // failure arrives asynchronously via the ChildProcess "error" event.
  await new Promise<void>((resolve, reject) => {
    const onSpawn = (): void => {
      child.off("error", onInitialError);
      resolve();
    };
    const onInitialError = (err: Error): void => {
      child.off("spawn", onSpawn);
      reject(err);
    };
    child.once("spawn", onSpawn);
    child.once("error", onInitialError);
  });

  processes.set(id, proc);

  if (options.stdin !== undefined) child.stdin.write(options.stdin);
  return proc;
}

const envSchema = z.record(z.string()).default({});
const argsSchema = z.array(z.string()).max(500).default([]);

const commandSpecSchema = z.object({
  command: z.string(),
  args: argsSchema,
  cwd: z.string().default("."),
  env: envSchema,
  stdin: z.string().optional(),
  timeout_ms: z.number().int().min(1).max(MAX_COMMAND_TIMEOUT_MS).default(DEFAULT_COMMAND_TIMEOUT_MS),
  max_output_bytes: z.number().int().min(1024).max(MAX_COMMAND_OUTPUT_BYTES).default(defaultCommandOutputBytes()),
});

export function registerTerminalTools(server: McpServer): void {
  server.registerTool(
    "run_command",
    {
      title: "Run command",
      description:
        "Runs one program directly (no shell) and waits for completion. stdout/stderr are bounded with head+tail retention; max_output_bytes defaults from COMMAND_MAX_OUTPUT_BYTES (65536). cwd must be relative to the active workspace. The command itself is not sandboxed and runs with the MCP process user's OS permissions.",
      inputSchema: {
        command: z.string(),
        args: argsSchema,
        cwd: z.string().default("."),
        env: envSchema,
        stdin: z.string().optional(),
        timeout_ms: z.number().int().min(1).max(MAX_COMMAND_TIMEOUT_MS).default(DEFAULT_COMMAND_TIMEOUT_MS),
        max_output_bytes: z.number().int().min(1024).max(MAX_COMMAND_OUTPUT_BYTES).default(defaultCommandOutputBytes()),
      },
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ command, args = [], cwd = ".", env = {}, stdin, timeout_ms = DEFAULT_COMMAND_TIMEOUT_MS, max_output_bytes = defaultCommandOutputBytes() }) => {
      try {
        const result = await runWorkspaceCommand({
          command,
          args,
          cwd,
          env,
          stdin,
          timeoutMs: timeout_ms,
          maxOutputBytes: max_output_bytes,
        });
        return ok(result as unknown as Record<string, unknown>);
      } catch (err: unknown) {
        return fail((err as Error).message);
      }
    }
  );

  server.registerTool(
    "run_commands",
    {
      title: "Run multiple commands in one call",
      description:
        "Batches up to 20 direct program invocations into ONE MCP round trip. Each command has bounded head+tail stdout/stderr retention using max_output_bytes. Use sequential mode for dependent commands/build pipelines and parallel mode for independent diagnostics. In sequential mode, stop_on_error=true prevents later commands from starting after the first failure. In parallel mode all commands start concurrently, so stop_on_error cannot cancel commands that have already started. cwd values are relative to the active workspace. Commands are not sandboxed.",
      inputSchema: {
        commands: z.array(commandSpecSchema).min(1).max(20),
        mode: z.enum(["sequential", "parallel"]).default("sequential"),
        stop_on_error: z.boolean().default(true),
      },
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ commands, mode = "sequential", stop_on_error = true }) => {
      try {
        const startedAt = Date.now();
        const results: Array<CommandResult & { index: number }> = [];

        const execute = async (spec: z.infer<typeof commandSpecSchema>, index: number) => {
          const commandStartedAt = Date.now();
          try {
            const result = await runWorkspaceCommand({
              command: spec.command,
              args: spec.args,
              cwd: spec.cwd,
              env: spec.env,
              stdin: spec.stdin,
              timeoutMs: spec.timeout_ms,
              maxOutputBytes: spec.max_output_bytes,
            });
            return { index, ...result };
          } catch (err: unknown) {
            // Keep per-command setup/validation failures inside the batch result
            // so one bad cwd/command does not discard results from sibling calls.
            return {
              index,
              ok: false,
              command: spec.command,
              args: spec.args,
              cwd: spec.cwd,
              pid: null,
              exitCode: null,
              exit_code: null,
              signal: null,
              timedOut: false,
              timed_out: false,
              durationMs: Date.now() - commandStartedAt,
              duration_ms: Date.now() - commandStartedAt,
              stdout: "",
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
              stdout_truncated: false,
              stderr_truncated: false,
              stdoutBytes: 0,
              stderrBytes: 0,
              stdout_bytes: 0,
              stderr_bytes: 0,
              stdoutRetainedBytes: 0,
              stderrRetainedBytes: 0,
              stdout_retained_bytes: 0,
              stderr_retained_bytes: 0,
              stdoutOmittedBytes: 0,
              stderrOmittedBytes: 0,
              stdout_omitted_bytes: 0,
              stderr_omitted_bytes: 0,
              maxOutputBytes: spec.max_output_bytes,
              max_output_bytes: spec.max_output_bytes,
              error: (err as Error).message,
            } satisfies CommandResult & { index: number };
          }
        };

        if (mode === "parallel") {
          // Start every command before awaiting the group. Promise.all preserves
          // input order in the returned result array even if commands finish out
          // of order. This is the low-round-trip path for independent checks.
          results.push(...(await Promise.all(commands.map((spec, index) => execute(spec, index)))));
        } else {
          for (let index = 0; index < commands.length; index += 1) {
            const result = await execute(commands[index], index);
            results.push(result);
            if (stop_on_error && !result.ok) break;
          }
        }

        const failed = results.filter((result) => !result.ok).length;
        const succeeded = results.length - failed;
        const skippedCommands = commands.slice(results.length).map((spec, offset) => ({
          index: results.length + offset,
          command: spec.command,
          args: spec.args,
          cwd: spec.cwd,
          reason: "Skipped because an earlier sequential command failed and stop_on_error=true.",
        }));
        const stoppedEarly = skippedCommands.length > 0;
        const allRequestedCommandsCompleted = results.length === commands.length;

        return ok({
          ok: allRequestedCommandsCompleted && failed === 0,
          mode,
          stopOnError: stop_on_error,
          stopOnErrorEffective: mode === "sequential" && stop_on_error,
          parallelism: mode === "parallel" ? commands.length : 1,
          requested: commands.length,
          started: results.length,
          completed: results.length,
          succeeded,
          failed,
          skipped: skippedCommands.length,
          stoppedEarly,
          firstFailureIndex: results.find((result) => !result.ok)?.index ?? null,
          durationMs: Date.now() - startedAt,
          results,
          skippedCommands,
        });
      } catch (err: unknown) {
        return fail((err as Error).message);
      }
    }
  );

  server.registerTool(
    "start_process",
    {
      title: "Start background process",
      description:
        "Starts a long-running process such as a dev server or watcher. Returns a process_id for read_process/write_process/stop_process. cwd is workspace-relative; the process is not sandboxed.",
      inputSchema: {
        command: z.string(),
        args: argsSchema,
        cwd: z.string().default("."),
        env: envSchema,
        stdin: z.string().optional(),
        max_buffer_bytes: z.number().int().min(4096).max(MAX_PROCESS_BUFFER_BYTES).default(DEFAULT_PROCESS_BUFFER_BYTES),
      },
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ command, args = [], cwd = ".", env = {}, stdin, max_buffer_bytes = DEFAULT_PROCESS_BUFFER_BYTES }) => {
      try {
        const proc = await startManagedProcess({
          command,
          args,
          cwd,
          env,
          stdin,
          maxBufferBytes: max_buffer_bytes,
        });
        return ok({ ok: true, ...processSummary(proc) });
      } catch (err: unknown) {
        return fail((err as Error).message);
      }
    }
  );

  server.registerTool(
    "read_process",
    {
      title: "Read background process output",
      description:
        "Reads and consumes only new stdout/stderr buffered since previous reads for a managed process. wait_ms can briefly wait for fresh output or process exit, reducing repeated polling MCP calls.",
      inputSchema: {
        process_id: z.string(),
        max_bytes_per_stream: z.number().int().min(1).max(MAX_PROCESS_BUFFER_BYTES).default(DEFAULT_PROCESS_READ_BYTES),
        wait_ms: z.number().int().min(0).max(MAX_PROCESS_READ_WAIT_MS).default(0),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ process_id, max_bytes_per_stream = DEFAULT_PROCESS_READ_BYTES, wait_ms = 0 }) => {
      const proc = processes.get(process_id);
      if (!proc) return fail(`Unknown process_id: ${process_id}`);

      await waitForProcessOutput(proc, wait_ms);
      const stdout = proc.stdout.drain(max_bytes_per_stream);
      const stderr = proc.stderr.drain(max_bytes_per_stream);
      return ok({
        ok: true,
        ...processSummary(proc),
        stdout: stdout.text,
        stderr: stderr.text,
        stdoutReadBytes: stdout.bytes,
        stderrReadBytes: stderr.bytes,
        stdoutRemainingBytes: stdout.remainingBytes,
        stderrRemainingBytes: stderr.remainingBytes,
        stdoutDroppedBeforeRead: stdout.droppedBytes,
        stderrDroppedBeforeRead: stderr.droppedBytes,
        hasMoreOutput: stdout.remainingBytes > 0 || stderr.remainingBytes > 0,
      });
    }
  );

  server.registerTool(
    "write_process",
    {
      title: "Write to background process",
      description: "Writes text to stdin of a running managed process. Optionally closes stdin after writing.",
      inputSchema: {
        process_id: z.string(),
        data: z.string(),
        end: z.boolean().default(false),
      },
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ process_id, data, end = false }) => {
      const proc = processes.get(process_id);
      if (!proc) return fail(`Unknown process_id: ${process_id}`);
      if (proc.status !== "running") return fail(`Process ${process_id} is not running.`, processSummary(proc));
      if (!proc.child.stdin.writable) return fail(`stdin is not writable for process ${process_id}.`);

      try {
        await new Promise<void>((resolve, reject) => {
          const callback = (err?: Error | null): void => (err ? reject(err) : resolve());
          if (end) proc.child.stdin.end(data, callback);
          else proc.child.stdin.write(data, callback);
        });
        if (end) proc.stdinClosed = true;
        return ok({ ok: true, process_id, bytesWritten: Buffer.byteLength(data), stdinEnded: end });
      } catch (err: unknown) {
        return fail((err as Error).message);
      }
    }
  );

  server.registerTool(
    "stop_process",
    {
      title: "Stop background process",
      description: "Stops a managed process and its child process tree when possible.",
      inputSchema: {
        process_id: z.string(),
        grace_ms: z.number().int().min(0).max(MAX_STOP_GRACE_MS).default(DEFAULT_STOP_GRACE_MS),
        force: z.boolean().default(true),
      },
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ process_id, grace_ms = DEFAULT_STOP_GRACE_MS, force = true }) => {
      const proc = processes.get(process_id);
      if (!proc) return fail(`Unknown process_id: ${process_id}`);
      if (!processIsActive(proc)) return ok({ ok: true, alreadyStopped: true, ...processSummary(proc) });

      try {
        proc.status = "stopping";
        proc.stopRequestedAt = Date.now();
        await signalProcessTree(proc.child, false);
        let exited = await waitForManagedProcessExit(proc, grace_ms);
        let forced = false;
        if (!exited && force) {
          forced = true;
          await signalProcessTree(proc.child, true);
          exited = await waitForManagedProcessExit(proc, 2_000);
        }
        return ok({
          ok: exited,
          stopRequested: true,
          forced,
          ...processSummary(proc),
        });
      } catch (err: unknown) {
        return fail((err as Error).message, processSummary(proc));
      }
    }
  );

  server.registerTool(
    "list_processes",
    {
      title: "List background processes",
      description: "Lists processes started through start_process, including running/exited status and unread output sizes.",
      inputSchema: {
        include_exited: z.boolean().default(true),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ include_exited = true }) => {
      const all = [...processes.values()]
        .filter((proc) => include_exited || processIsActive(proc))
        .sort((a, b) => b.startedAt - a.startedAt)
        .map(processSummary);
      return ok({ ok: true, count: all.length, workspaceRoot: await getActiveWorkspaceRoot(), processes: all });
    }
  );
}
