import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, type Dirent, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

type ToolResult = {
  structuredContent?: Record<string, unknown>;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

type WorkspaceResolveOptions = {
  ensureParent?: boolean;
  rejectSymlinkTarget?: boolean;
};

type BackupFile = {
  path: string;
  size: number;
  modifiedAtMs: number;
};

type SearchMode = "path" | "content" | "both";

type SearchMatch = {
  path: string;
  absolutePath: string;
  matchType: "path" | "content";
  line?: number;
  column?: number;
  preview: string;
};

type FileIndexEntry = {
  rel: string;
  fullPath: string;
  size: number;
  mtimeMs: number;
};

type FileIndexResult = {
  files: FileIndexEntry[];
  skippedFiles: number;
  truncated: boolean;
  fromCache: boolean;
};

type SearchIndexCacheEntry = Omit<FileIndexResult, "fromCache"> & {
  createdAtMs: number;
};

type CompiledGlob = {
  raw: string;
  normalized: string;
  matches: (relPath: string) => boolean;
};

type RipgrepBatchResult = {
  matches: SearchMatch[];
  truncated: boolean;
};

const RAW_WRITE_ENABLE_PHRASE = "I_UNDERSTAND_THIS_CAN_DESTROY_FILES";
const RAW_READ_ENABLE_PHRASE = "I_UNDERSTAND_THIS_CAN_READ_PRIVATE_FILES";
const DEFAULT_HOME = "~/.chatgpt-local-file-mcp";
const DEFAULT_WORKSPACE = "~/ChatGPT-editable";
const SHA256_SIZE_LIMIT = 100_000_000;
const DEFAULT_SEARCH_INCLUDES = ["**/*"];
const DEFAULT_SEARCH_EXCLUDES = [
  "node_modules/**",
  ".git/**",
  "dist/**",
  "build/**",
  "out/**",
  "coverage/**",
  ".next/**",
  ".turbo/**",
  ".cache/**",
  ".venv/**",
  "venv/**",
  "__pycache__/**",
  "target/**",
  "bin/**",
  "obj/**",
  "*.min.js",
  "*.map",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
];
const DEFAULT_SEARCH_MODE: SearchMode = "both";
const SEARCH_INDEX_CACHE_TTL_MS = 15_000;
const SEARCH_CONCURRENCY = 16;
const RIPGREP_WINDOWS_ARG_CHARS = 7_000;
const RIPGREP_POSIX_ARG_CHARS = 120_000;

let activeWorkspaceOverride: string | null = null;
const searchIndexCache = new Map<string, SearchIndexCacheEntry>();

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

function expandHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function abs(input: string): string {
  if (!input || input.includes("\0")) {
    throw new Error("Invalid path.");
  }
  return path.resolve(expandHome(input));
}

function mcpHome(): string {
  return abs(process.env.CHATGPT_FILE_MCP_HOME || DEFAULT_HOME);
}

function isRawWriteEnabled(): boolean {
  return process.env.ALLOW_RAW_WRITE_ANY_FILE === RAW_WRITE_ENABLE_PHRASE;
}

function isRawReadEnabled(): boolean {
  return process.env.ALLOW_RAW_READ_ANY_FILE === RAW_READ_ENABLE_PHRASE || isRawWriteEnabled();
}

function parseNamedWorkspaces(): Record<string, string> {
  const configured = process.env.WORKSPACE_ROOTS || "";
  const result: Record<string, string> = {};

  for (const rawPair of configured.split(",")) {
    const pair = rawPair.trim();
    if (!pair) continue;

    const equalsAt = pair.indexOf("=");
    if (equalsAt <= 0) continue;

    const name = pair.slice(0, equalsAt).trim();
    const value = pair.slice(equalsAt + 1).trim();
    if (!name || !value) continue;

    result[name] = value;
  }

  return result;
}

function namedWorkspaceStatus(): Record<string, string> {
  const named = parseNamedWorkspaces();
  const result: Record<string, string> = {};

  for (const [name, configuredPath] of Object.entries(named)) {
    try {
      result[name] = abs(configuredPath);
    } catch {
      result[name] = configuredPath;
    }
  }

  return result;
}

function configuredWorkspaceInput(): string {
  if (activeWorkspaceOverride) return activeWorkspaceOverride;

  const named = parseNamedWorkspaces();
  const defaultWorkspaceName = process.env.DEFAULT_WORKSPACE || "";
  if (defaultWorkspaceName && named[defaultWorkspaceName]) {
    return named[defaultWorkspaceName];
  }

  return process.env.WORKSPACE_ROOT || DEFAULT_WORKSPACE;
}

function workspaceSource(): string {
  if (activeWorkspaceOverride) return "runtime_override";

  const named = parseNamedWorkspaces();
  const defaultWorkspaceName = process.env.DEFAULT_WORKSPACE || "";
  if (defaultWorkspaceName && named[defaultWorkspaceName]) {
    return `named:${defaultWorkspaceName}`;
  }

  if (process.env.WORKSPACE_ROOT) return "WORKSPACE_ROOT";
  return "default";
}

async function workspaceRoot(): Promise<string> {
  const configured = abs(configuredWorkspaceInput());
  await fs.mkdir(configured, { recursive: true });
  return await fs.realpath(configured);
}

async function setActiveWorkspace(inputPath: string): Promise<string> {
  const target = abs(inputPath);
  await fs.mkdir(target, { recursive: true });
  const realTarget = await fs.realpath(target);
  activeWorkspaceOverride = realTarget;
  searchIndexCache.clear();
  return realTarget;
}

function assertRawWriteEnabled(): void {
  if (!isRawWriteEnabled()) {
    throw new Error(
      `write_any_file is disabled. Set ALLOW_RAW_WRITE_ANY_FILE=${RAW_WRITE_ENABLE_PHRASE} to enable it.`
    );
  }
}

function assertRawReadEnabled(): void {
  if (!isRawReadEnabled()) {
    throw new Error(
      `raw reads are disabled. Set ALLOW_RAW_READ_ANY_FILE=${RAW_READ_ENABLE_PHRASE} to enable read_any_file/list_any_dir, or enable raw writes for backwards compatibility.`
    );
  }
}

async function resolveInsideWorkspace(relativeOrSubpath: string, options: WorkspaceResolveOptions = {}): Promise<string> {
  const root = await workspaceRoot();
  const expandedInput = expandHome(relativeOrSubpath);
  if (path.isAbsolute(expandedInput)) {
    throw new Error("Workspace tools require a path relative to WORKSPACE_ROOT, not an absolute path.");
  }

  const target = path.resolve(root, relativeOrSubpath || ".");
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error("Path escapes WORKSPACE_ROOT.");
  }

  if (target !== root) {
    const parent = path.dirname(target);
    if (options.ensureParent) {
      await fs.mkdir(parent, { recursive: true });
    }

    try {
      const realParent = await fs.realpath(parent);
      if (realParent !== root && !realParent.startsWith(root + path.sep)) {
        throw new Error("Resolved parent escapes WORKSPACE_ROOT, possibly through a symlink.");
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  if (options.rejectSymlinkTarget !== false) {
    try {
      const lst = await fs.lstat(target);
      if (lst.isSymbolicLink()) throw new Error("Refusing to use a workspace path that is a symlink.");
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  return target;
}

async function sha256File(filePath: string): Promise<string | null> {
  try {
    const st = await fs.stat(filePath);
    if (!st.isFile() || st.size > SHA256_SIZE_LIMIT) return null;

    return await new Promise<string>((resolve, reject) => {
      const hash = createHash("sha256");
      const stream = createReadStream(filePath);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("error", reject);
      stream.on("end", () => resolve(hash.digest("hex")));
    });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function backupRetentionPolicy(): { retentionDays: number; maxBackupMb: number; enabled: boolean } {
  const retentionDays = Math.max(0, envInt("BACKUP_RETENTION_DAYS", 0));
  const maxBackupMb = Math.max(0, envInt("MAX_BACKUP_MB", 0));
  return { retentionDays, maxBackupMb, enabled: retentionDays > 0 || maxBackupMb > 0 };
}

async function collectBackupFiles(root: string): Promise<BackupFile[]> {
  const files: BackupFile[] = [];

  async function visit(dir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await visit(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const st = await fs.stat(fullPath);
      files.push({ path: fullPath, size: st.size, modifiedAtMs: st.mtimeMs });
    }
  }

  await visit(root);
  return files;
}

async function cleanupEmptyDirs(root: string, current: string = root): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(current, { withFileTypes: true });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      await cleanupEmptyDirs(root, path.join(current, entry.name));
    }
  }

  if (current !== root) {
    try {
      await fs.rmdir(current);
    } catch {
      // Directory is not empty or was removed by another process.
    }
  }
}

async function cleanupBackups(): Promise<Record<string, unknown>> {
  const policy = backupRetentionPolicy();
  const backupRoot = path.join(mcpHome(), "backups");
  await fs.mkdir(backupRoot, { recursive: true });

  let files = await collectBackupFiles(backupRoot);
  const startingFiles = files.length;
  const startingBytes = files.reduce((sum, file) => sum + file.size, 0);
  let deletedFiles = 0;
  let deletedBytes = 0;

  async function removeBackup(file: BackupFile): Promise<void> {
    try {
      await fs.unlink(file.path);
      deletedFiles += 1;
      deletedBytes += file.size;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  if (policy.retentionDays > 0) {
    const cutoff = Date.now() - policy.retentionDays * 24 * 60 * 60 * 1000;
    const oldFiles = files.filter((file) => file.modifiedAtMs < cutoff);
    for (const file of oldFiles) {
      await removeBackup(file);
    }
    files = files.filter((file) => file.modifiedAtMs >= cutoff);
  }

  if (policy.maxBackupMb > 0) {
    const maxBytes = policy.maxBackupMb * 1024 * 1024;
    let currentBytes = files.reduce((sum, file) => sum + file.size, 0);
    const oldestFirst = [...files].sort((a, b) => a.modifiedAtMs - b.modifiedAtMs);
    for (const file of oldestFirst) {
      if (currentBytes <= maxBytes) break;
      await removeBackup(file);
      currentBytes -= file.size;
    }
  }

  await cleanupEmptyDirs(backupRoot);
  const remainingFiles = await collectBackupFiles(backupRoot);
  const remainingBytes = remainingFiles.reduce((sum, file) => sum + file.size, 0);

  return {
    ok: true,
    backupRoot,
    policy,
    startingFiles,
    startingBytes,
    deletedFiles,
    deletedBytes,
    remainingFiles: remainingFiles.length,
    remainingBytes,
  };
}

async function maybeCleanupBackups(): Promise<Record<string, unknown> | null> {
  if (!backupRetentionPolicy().enabled) return null;
  try {
    return await cleanupBackups();
  } catch (err: unknown) {
    return { ok: false, error: (err as Error).message };
  }
}

async function maybeBackupFile(target: string, createBackup: boolean): Promise<string | null> {
  if (!createBackup) return null;

  try {
    const stat = await fs.stat(target);
    if (!stat.isFile()) return null;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const backupRoot = path.join(mcpHome(), "backups", day);
  await fs.mkdir(backupRoot, { recursive: true });

  const base = path.basename(target).replace(/[^a-zA-Z0-9._-]/g, "_") || "file";
  const hash = createHash("sha256").update(target).digest("hex").slice(0, 12);
  const backupPath = path.join(backupRoot, `${base}.${hash}.${now.getTime()}.bak`);
  await fs.copyFile(target, backupPath);
  return backupPath;
}

async function appendAudit(event: Record<string, unknown>): Promise<void> {
  const auditDir = path.join(mcpHome(), "audit");
  await fs.mkdir(auditDir, { recursive: true });
  const line = JSON.stringify({ ts: new Date().toISOString(), id: randomUUID(), ...event }) + "\n";
  await fs.appendFile(path.join(auditDir, "writes.jsonl"), line, "utf8");
}

async function readTextFile(target: string, maxBytes: number): Promise<{ text: string; bytesRead: number; truncated: boolean; sha256: string | null }> {
  const stat = await fs.stat(target);
  if (!stat.isFile()) throw new Error("Target is not a regular file.");
  if (maxBytes < 1 || maxBytes > 10_000_000) throw new Error("max_bytes must be between 1 and 10,000,000.");

  const fh = await fs.open(target, "r");
  try {
    const length = Math.min(Number(stat.size), maxBytes);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buffer, 0, length, 0);
    return {
      text: buffer.subarray(0, bytesRead).toString("utf8"),
      bytesRead,
      truncated: stat.size > bytesRead,
      sha256: await sha256File(target),
    };
  } finally {
    await fh.close();
  }
}

async function readFullUtf8File(target: string): Promise<string> {
  const stat = await fs.stat(target);
  if (!stat.isFile()) throw new Error("Target is not a regular file.");
  return await fs.readFile(target, "utf8");
}

async function atomicWriteUtf8File(target: string, content: string): Promise<void> {
  const parent = path.dirname(target);
  await fs.mkdir(parent, { recursive: true });
  const tempPath = path.join(parent, `.${path.basename(target)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);

  try {
    await fs.writeFile(tempPath, content, { encoding: "utf8", flag: "wx" });
    await fs.rename(tempPath, target);
  } catch (err) {
    try {
      await fs.unlink(tempPath);
    } catch {
      // Best-effort cleanup only.
    }
    throw err;
  }
}

async function writeTextFile(target: string, content: string, createBackup: boolean, tool: string): Promise<Record<string, unknown>> {
  const parent = path.dirname(target);
  await fs.mkdir(parent, { recursive: true });

  const beforeSha256 = await sha256File(target);
  const backupPath = await maybeBackupFile(target, createBackup);
  await atomicWriteUtf8File(target, content);
  invalidateSearchIndexCacheForPath(target);
  const afterSha256 = sha256Text(content);
  const bytesWritten = Buffer.byteLength(content, "utf8");

  const event = {
    tool,
    path: target,
    bytesWritten,
    beforeSha256,
    afterSha256,
    backupPath,
  };
  await appendAudit(event);
  const backupCleanup = await maybeCleanupBackups();
  return { ok: true, ...event, backupCleanup };
}

async function listDir(target: string, maxEntries: number): Promise<Record<string, unknown>> {
  if (maxEntries < 1 || maxEntries > 1000) throw new Error("max_entries must be between 1 and 1000.");
  const entries = await fs.readdir(target, { withFileTypes: true });
  const listed = entries.slice(0, maxEntries).map((entry) => ({
    name: entry.name,
    type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "symlink" : "other",
  }));
  return { ok: true, path: target, count: entries.length, truncated: entries.length > listed.length, entries: listed };
}

async function statPath(target: string): Promise<Record<string, unknown>> {
  const st = await fs.lstat(target);
  return {
    ok: true,
    path: target,
    type: st.isDirectory() ? "directory" : st.isFile() ? "file" : st.isSymbolicLink() ? "symlink" : "other",
    size: st.size,
    mode: st.mode,
    createdAt: st.birthtime.toISOString(),
    modifiedAt: st.mtime.toISOString(),
    isSymlink: st.isSymbolicLink(),
    sha256: st.isFile() && !st.isSymbolicLink() ? await sha256File(target) : null,
  };
}

function normalizeSlashes(input: string): string {
  return input.replace(/\\/g, "/").replace(/^\.\//, "");
}

function workspaceRelative(root: string, target: string): string {
  const rel = path.relative(root, target) || ".";
  return normalizeSlashes(rel);
}

function escapeRegExp(input: string): string {
  return input.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegExp(glob: string): RegExp {
  const normalized = normalizeSlashes(glob);
  let pattern = "^";

  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i];
    if (char === "*") {
      if (normalized[i + 1] === "*") {
        if (normalized[i + 2] === "/") {
          pattern += "(?:.*/)?";
          i += 2;
        } else {
          pattern += ".*";
          i += 1;
        }
      } else {
        pattern += "[^/]*";
      }
    } else if (char === "?") {
      pattern += "[^/]";
    } else {
      pattern += escapeRegExp(char);
    }
  }

  pattern += "$";
  return new RegExp(pattern);
}

function compileGlob(glob: string): CompiledGlob {
  const normalized = normalizeSlashes(glob.trim());

  return {
    raw: glob,
    normalized,
    matches: (relPath: string) => {
      const rel = normalizeSlashes(relPath);
      if (!normalized || normalized === "**" || normalized === "**/*") return true;

      if (normalized.endsWith("/**")) {
        const prefix = normalized.slice(0, -3);
        return rel === prefix || rel.startsWith(prefix + "/");
      }

      return globToRegExp(normalized).test(rel);
    },
  };
}

function compileGlobs(globs: string[]): CompiledGlob[] {
  return globs.map((glob) => compileGlob(glob)).filter((glob) => glob.normalized.length > 0);
}

function matchesAnyCompiledGlob(relPath: string, globs: CompiledGlob[]): boolean {
  return globs.some((glob) => glob.matches(relPath));
}

function isIncludedByCompiledGlobs(relPath: string, includeGlobs: CompiledGlob[], excludeGlobs: CompiledGlob[]): boolean {
  const included = includeGlobs.length === 0 || matchesAnyCompiledGlob(relPath, includeGlobs);
  if (!included) return false;
  return !matchesAnyCompiledGlob(relPath, excludeGlobs);
}

function normalizeGlobList(globs: string[]): string[] {
  return globs.map((glob) => normalizeSlashes(glob.trim())).filter(Boolean);
}

function searchIndexCacheKey(root: string, includeGlobs: string[], excludeGlobs: string[], maxFiles: number): string {
  return JSON.stringify({
    root,
    includeGlobs: normalizeGlobList(includeGlobs),
    excludeGlobs: normalizeGlobList(excludeGlobs),
    maxFiles,
  });
}

function searchIndexCacheTtlMs(): number {
  return Math.max(0, envInt("SEARCH_INDEX_CACHE_TTL_MS", SEARCH_INDEX_CACHE_TTL_MS));
}

function searchConcurrency(): number {
  return Math.max(1, Math.min(64, envInt("SEARCH_CONCURRENCY", SEARCH_CONCURRENCY)));
}

function shouldUseRipgrep(): boolean {
  const raw = (process.env.SEARCH_USE_RIPGREP || "true").toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "no";
}

function ripgrepBinary(): string {
  return process.env.RIPGREP_PATH || "rg";
}

function invalidateSearchIndexCacheForPath(target: string): void {
  const normalizedTarget = normalizeSlashes(path.resolve(target));
  for (const key of Array.from(searchIndexCache.keys())) {
    try {
      const parsed = JSON.parse(key) as { root?: string };
      if (!parsed.root) continue;
      const normalizedRoot = normalizeSlashes(path.resolve(parsed.root));
      if (normalizedTarget === normalizedRoot || normalizedTarget.startsWith(normalizedRoot + "/")) {
        searchIndexCache.delete(key);
      }
    } catch {
      searchIndexCache.delete(key);
    }
  }
}

async function runLimited<T>(items: T[], limit: number, worker: (item: T, index: number) => Promise<void>, shouldStop?: () => boolean): Promise<void> {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      if (shouldStop?.()) return;
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  });

  await Promise.all(workers);
}

async function getWorkspaceFileIndex(root: string, includeGlobs: string[], excludeGlobs: string[], maxFiles: number): Promise<FileIndexResult> {
  const cacheKey = searchIndexCacheKey(root, includeGlobs, excludeGlobs, maxFiles);
  const ttlMs = searchIndexCacheTtlMs();
  const cached = searchIndexCache.get(cacheKey);
  if (cached && ttlMs > 0 && Date.now() - cached.createdAtMs <= ttlMs) {
    return {
      files: cached.files,
      skippedFiles: cached.skippedFiles,
      truncated: cached.truncated,
      fromCache: true,
    };
  }

  const includeMatchers = compileGlobs(includeGlobs);
  const excludeMatchers = compileGlobs(excludeGlobs);
  const files: FileIndexEntry[] = [];
  let skippedFiles = 0;
  let truncated = false;

  async function visit(dir: string): Promise<void> {
    if (files.length >= maxFiles) {
      truncated = true;
      return;
    }

    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      skippedFiles += 1;
      return;
    }

    for (const entry of entries) {
      if (files.length >= maxFiles) {
        truncated = true;
        return;
      }

      if (entry.isSymbolicLink()) {
        skippedFiles += 1;
        continue;
      }

      const fullPath = path.join(dir, entry.name);
      const rel = workspaceRelative(root, fullPath);

      if (matchesAnyCompiledGlob(rel, excludeMatchers)) {
        if (entry.isFile()) skippedFiles += 1;
        continue;
      }

      if (entry.isDirectory()) {
        await visit(fullPath);
        continue;
      }

      if (!entry.isFile()) {
        skippedFiles += 1;
        continue;
      }

      if (!isIncludedByCompiledGlobs(rel, includeMatchers, excludeMatchers)) {
        skippedFiles += 1;
        continue;
      }

      try {
        const st = await fs.stat(fullPath);
        if (!st.isFile()) {
          skippedFiles += 1;
          continue;
        }
        files.push({ rel, fullPath, size: st.size, mtimeMs: st.mtimeMs });
      } catch {
        skippedFiles += 1;
      }
    }
  }

  await visit(root);

  const result = { files, skippedFiles, truncated, createdAtMs: Date.now() };
  if (ttlMs > 0) searchIndexCache.set(cacheKey, result);

  return { files, skippedFiles, truncated, fromCache: false };
}

function previewLine(line: string, index: number, needleLength: number): string {
  const start = Math.max(0, index - 60);
  const end = Math.min(line.length, index + needleLength + 60);
  return line.slice(start, end).trim();
}

function ripgrepArgCharLimit(): number {
  return process.platform === "win32" ? RIPGREP_WINDOWS_ARG_CHARS : RIPGREP_POSIX_ARG_CHARS;
}

function makeRipgrepBatches(files: FileIndexEntry[]): FileIndexEntry[][] {
  const batches: FileIndexEntry[][] = [];
  const charLimit = ripgrepArgCharLimit();
  const maxBatchFiles = process.platform === "win32" ? 150 : 1000;
  let current: FileIndexEntry[] = [];
  let currentChars = 0;

  for (const file of files) {
    const argChars = file.rel.length + 3;
    if (current.length > 0 && (current.length >= maxBatchFiles || currentChars + argChars > charLimit)) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }

    current.push(file);
    currentChars += argChars;
  }

  if (current.length > 0) batches.push(current);
  return batches;
}

async function runRipgrepBatch(root: string, files: FileIndexEntry[], options: { query: string; maxResults: number; caseSensitive: boolean }): Promise<RipgrepBatchResult> {
  if (files.length === 0) return { matches: [], truncated: false };

  const args = [
    "--json",
    "--fixed-strings",
    "--line-number",
    "--column",
    "--color",
    "never",
    "--no-heading",
    "--with-filename",
    "--no-config",
    "--no-ignore",
    options.caseSensitive ? "--case-sensitive" : "--ignore-case",
    "--",
    options.query,
    ...files.map((file) => file.rel),
  ];

  return await new Promise<RipgrepBatchResult>((resolve, reject) => {
    const matches: SearchMatch[] = [];
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let truncated = false;
    let settled = false;

    const child = spawn(ripgrepBinary(), args, { cwd: root, windowsHide: true });

    function settle(result: RipgrepBatchResult | null, err?: Error): void {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(result ?? { matches, truncated });
    }

    function processJsonLine(line: string): void {
      if (!line.trim() || matches.length >= options.maxResults) return;

      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }

      const typed = event as {
        type?: string;
        data?: {
          path?: { text?: string };
          lines?: { text?: string };
          line_number?: number;
          submatches?: Array<{ start?: number; end?: number }>;
        };
      };

      if (typed.type !== "match" || !typed.data) return;
      const rel = normalizeSlashes(typed.data.path?.text || "");
      if (!rel) return;
      const lineText = (typed.data.lines?.text || "").replace(/\r?\n$/, "");
      const lineNumber = typed.data.line_number || 0;
      const absolutePath = path.join(root, rel);
      const submatches = typed.data.submatches || [];

      for (const submatch of submatches) {
        if (matches.length >= options.maxResults) {
          truncated = true;
          child.kill();
          return;
        }

        const foundAt = Math.max(0, submatch.start || 0);
        matches.push({
          path: rel,
          absolutePath,
          matchType: "content",
          line: lineNumber,
          column: foundAt + 1,
          preview: previewLine(lineText, foundAt, options.query.length),
        });
      }

      if (matches.length >= options.maxResults) {
        truncated = true;
        child.kill();
      }
    }

    function processStdoutChunk(chunk: string, flush = false): void {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      const remainder = lines.pop() ?? "";
      for (const line of lines) processJsonLine(line);
      if (flush && remainder) processJsonLine(remainder);
      stdoutBuffer = flush ? "" : remainder;
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => processStdoutChunk(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrBuffer += chunk;
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      settle(null, err);
    });

    child.on("close", (code, signal) => {
      processStdoutChunk("", true);
      if (truncated || code === 0 || code === 1) {
        settle({ matches, truncated });
        return;
      }

      const signalText = signal ? ` signal ${signal}` : "";
      const stderrText = stderrBuffer.trim();
      settle(null, new Error(stderrText || `ripgrep exited with code ${code}${signalText}.`));
    });
  });
}

async function searchContentWithRipgrep(root: string, files: FileIndexEntry[], options: { query: string; maxResults: number; caseSensitive: boolean }): Promise<RipgrepBatchResult> {
  const matches: SearchMatch[] = [];
  let truncated = false;

  for (const batch of makeRipgrepBatches(files)) {
    if (matches.length >= options.maxResults) {
      truncated = true;
      break;
    }

    const result = await runRipgrepBatch(root, batch, {
      query: options.query,
      maxResults: options.maxResults - matches.length,
      caseSensitive: options.caseSensitive,
    });

    matches.push(...result.matches);
    if (result.truncated || matches.length >= options.maxResults) {
      truncated = true;
      break;
    }
  }

  return { matches, truncated };
}

async function searchContentWithJavaScript(files: FileIndexEntry[], options: {
  query: string;
  needle: string;
  maxResults: number;
  maxFileBytes: number;
  caseSensitive: boolean;
  addMatch: (match: SearchMatch) => boolean;
  shouldStop: () => boolean;
}): Promise<{ scannedFiles: number; skippedFiles: number; truncated: boolean }> {
  let scannedFiles = 0;
  let skippedFiles = 0;
  let truncated = false;
  const queryBuffer = Buffer.from(options.query, "utf8");

  await runLimited(
    files,
    searchConcurrency(),
    async (file) => {
      if (options.shouldStop()) {
        truncated = true;
        return;
      }

      if (file.size > options.maxFileBytes) {
        skippedFiles += 1;
        return;
      }

      let buffer: Buffer;
      try {
        buffer = await fs.readFile(file.fullPath);
      } catch {
        skippedFiles += 1;
        return;
      }

      scannedFiles += 1;

      if (buffer.includes(0)) {
        skippedFiles += 1;
        return;
      }

      let text: string;
      if (options.caseSensitive) {
        if (!buffer.includes(queryBuffer)) return;
        text = buffer.toString("utf8");
      } else {
        text = buffer.toString("utf8");
        if (!text.toLowerCase().includes(options.needle)) return;
      }

      const lines = text.split(/\r?\n/);
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        if (options.shouldStop()) {
          truncated = true;
          return;
        }

        const line = lines[lineIndex];
        const haystack = options.caseSensitive ? line : line.toLowerCase();
        let fromIndex = 0;
        while (true) {
          const foundAt = haystack.indexOf(options.needle, fromIndex);
          if (foundAt === -1) break;

          const added = options.addMatch({
            path: file.rel,
            absolutePath: file.fullPath,
            matchType: "content",
            line: lineIndex + 1,
            column: foundAt + 1,
            preview: previewLine(line, foundAt, options.query.length),
          });

          if (!added) {
            truncated = true;
            return;
          }

          fromIndex = foundAt + Math.max(options.needle.length, 1);
        }
      }
    },
    options.shouldStop
  );

  return { scannedFiles, skippedFiles, truncated };
}

async function searchWorkspaceFiles(options: {
  query: string;
  includeGlobs: string[];
  excludeGlobs: string[];
  maxResults: number;
  maxFiles: number;
  maxFileBytes: number;
  caseSensitive: boolean;
  searchMode: SearchMode;
}): Promise<Record<string, unknown>> {
  const query = options.query;
  if (!query) throw new Error("query must not be empty.");
  if (options.maxResults < 1 || options.maxResults > 200) throw new Error("max_results must be between 1 and 200.");
  if (options.maxFiles < 1 || options.maxFiles > 50_000) throw new Error("max_files must be between 1 and 50,000.");
  if (options.maxFileBytes < 1 || options.maxFileBytes > 5_000_000) throw new Error("max_file_bytes must be between 1 and 5,000,000.");
  if (!["path", "content", "both"].includes(options.searchMode)) throw new Error("search_mode must be one of: path, content, both.");

  const root = await workspaceRoot();
  const needle = options.caseSensitive ? query : query.toLowerCase();
  const matches: SearchMatch[] = [];
  let scannedFiles = 0;
  let skippedFiles = 0;
  let truncated = false;
  let searchEngine: "path-only" | "ripgrep" | "javascript" = "path-only";
  let ripgrepError: string | null = null;

  function shouldStop(): boolean {
    return matches.length >= options.maxResults;
  }

  function addMatch(match: SearchMatch): boolean {
    if (matches.length >= options.maxResults) {
      truncated = true;
      return false;
    }

    matches.push(match);
    if (matches.length >= options.maxResults) truncated = true;
    return true;
  }

  const fileIndex = await getWorkspaceFileIndex(root, options.includeGlobs, options.excludeGlobs, options.maxFiles);
  skippedFiles += fileIndex.skippedFiles;
  if (fileIndex.truncated) truncated = true;

  if (options.searchMode === "path" || options.searchMode === "both") {
    for (const file of fileIndex.files) {
      const pathHaystack = options.caseSensitive ? file.rel : file.rel.toLowerCase();
      if (!pathHaystack.includes(needle)) continue;

      if (!addMatch({ path: file.rel, absolutePath: file.fullPath, matchType: "path", preview: file.rel })) break;
    }
  }

  if ((options.searchMode === "content" || options.searchMode === "both") && !shouldStop()) {
    const contentFiles = fileIndex.files.filter((file) => file.size <= options.maxFileBytes);
    skippedFiles += fileIndex.files.length - contentFiles.length;
    scannedFiles = contentFiles.length;

    if (shouldUseRipgrep()) {
      try {
        const rgResult = await searchContentWithRipgrep(root, contentFiles, {
          query,
          maxResults: options.maxResults - matches.length,
          caseSensitive: options.caseSensitive,
        });
        for (const match of rgResult.matches) addMatch(match);
        if (rgResult.truncated) truncated = true;
        searchEngine = "ripgrep";
      } catch (err: unknown) {
        ripgrepError = (err as Error).message;
      }
    }

    if (searchEngine !== "ripgrep" && !shouldStop()) {
      searchEngine = "javascript";
      const jsResult = await searchContentWithJavaScript(contentFiles, {
        query,
        needle,
        maxResults: options.maxResults - matches.length,
        maxFileBytes: options.maxFileBytes,
        caseSensitive: options.caseSensitive,
        addMatch,
        shouldStop,
      });
      scannedFiles = jsResult.scannedFiles;
      skippedFiles += jsResult.skippedFiles;
      if (jsResult.truncated) truncated = true;
    }
  }

  return {
    ok: true,
    workspaceRoot: root,
    query,
    searchMode: options.searchMode,
    searchEngine,
    ripgrepError,
    includeGlobs: options.includeGlobs,
    excludeGlobs: options.excludeGlobs,
    maxResults: options.maxResults,
    maxFiles: options.maxFiles,
    maxFileBytes: options.maxFileBytes,
    indexedFiles: fileIndex.files.length,
    indexFromCache: fileIndex.fromCache,
    searchIndexCacheTtlMs: searchIndexCacheTtlMs(),
    searchConcurrency: searchConcurrency(),
    scannedFiles,
    skippedFiles,
    count: matches.length,
    truncated,
    matches,
  };
}

async function replaceInWorkspaceFile(options: {
  relPath: string;
  oldText: string;
  newText: string;
  replaceAll: boolean;
  expectedReplacements?: number;
  createBackup: boolean;
}): Promise<Record<string, unknown>> {
  if (!options.oldText) throw new Error("old_text must not be empty.");
  const target = await resolveInsideWorkspace(options.relPath, { ensureParent: false });
  const text = await readFullUtf8File(target);
  const availableReplacements = text.split(options.oldText).length - 1;
  const replacements = options.replaceAll ? availableReplacements : Math.min(availableReplacements, 1);

  if (replacements === 0) throw new Error("old_text was not found.");
  if (options.expectedReplacements !== undefined && replacements !== options.expectedReplacements) {
    throw new Error(`Expected ${options.expectedReplacements} replacement(s), but would make ${replacements}.`);
  }

  const updated = options.replaceAll
    ? text.split(options.oldText).join(options.newText)
    : text.replace(options.oldText, options.newText);
  const result = await writeTextFile(target, updated, options.createBackup, "replace_in_file");
  return { ...result, replacements };
}

async function appendToWorkspaceFile(relPath: string, content: string, createBackup: boolean): Promise<Record<string, unknown>> {
  const target = await resolveInsideWorkspace(relPath, { ensureParent: true });
  let existing = "";
  try {
    existing = await readFullUtf8File(target);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return await writeTextFile(target, existing + content, createBackup, "append_to_file");
}

async function insertAfterInWorkspaceFile(options: {
  relPath: string;
  marker: string;
  content: string;
  occurrence: number;
  createBackup: boolean;
}): Promise<Record<string, unknown>> {
  if (!options.marker) throw new Error("marker must not be empty.");
  if (options.occurrence < 1) throw new Error("occurrence must be 1 or greater.");
  const target = await resolveInsideWorkspace(options.relPath, { ensureParent: false });
  const text = await readFullUtf8File(target);

  let fromIndex = 0;
  let foundAt = -1;
  for (let i = 0; i < options.occurrence; i += 1) {
    foundAt = text.indexOf(options.marker, fromIndex);
    if (foundAt === -1) {
      throw new Error(`marker occurrence ${options.occurrence} was not found.`);
    }
    fromIndex = foundAt + options.marker.length;
  }

  const insertAt = foundAt + options.marker.length;
  const updated = text.slice(0, insertAt) + options.content + text.slice(insertAt);
  const result = await writeTextFile(target, updated, options.createBackup, "insert_after");
  return { ...result, occurrence: options.occurrence, insertedAt: insertAt };
}

export function registerFileTools(server: McpServer): void {
  server.registerTool(
    "get_file_tool_status",
    {
      title: "Get local file tool status",
      description: "Shows configuration, workspace root, raw read/write status, backup directory, audit log path, and workspace switching state.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const root = await workspaceRoot();
        return ok({
          ok: true,
          workspaceRoot: root,
          workspaceSource: workspaceSource(),
          namedWorkspaces: namedWorkspaceStatus(),
          rawReadAnyFileEnabled: isRawReadEnabled(),
          rawWriteAnyFileEnabled: isRawWriteEnabled(),
          mcpHome: mcpHome(),
          backups: path.join(mcpHome(), "backups"),
          backupRetention: backupRetentionPolicy(),
          auditLog: path.join(mcpHome(), "audit", "writes.jsonl"),
        });
      } catch (err: unknown) {
        return fail((err as Error).message);
      }
    }
  );

  server.registerTool(
    "set_workspace_root",
    {
      title: "Set workspace root",
      description: "Changes the active WORKSPACE_ROOT for this running MCP server process. Creates the directory if needed.",
      inputSchema: {
        path: z.string(),
      },
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ path: inputPath }) => {
      try {
        const root = await setActiveWorkspace(inputPath);
        return ok({ ok: true, workspaceRoot: root, workspaceSource: workspaceSource() });
      } catch (err: unknown) {
        return fail((err as Error).message);
      }
    }
  );

  server.registerTool(
    "switch_workspace",
    {
      title: "Switch named workspace",
      description: "Switches to a named workspace configured in WORKSPACE_ROOTS, for example project=C:\\path,docs=C:\\other.",
      inputSchema: {
        name: z.string(),
      },
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ name }) => {
      try {
        const named = parseNamedWorkspaces();
        if (!named[name]) {
          return fail(`Unknown workspace \"${name}\".`, { available: Object.keys(named) });
        }
        const root = await setActiveWorkspace(named[name]);
        return ok({ ok: true, name, workspaceRoot: root, workspaceSource: workspaceSource() });
      } catch (err: unknown) {
        return fail((err as Error).message);
      }
    }
  );

  server.registerTool(
    "list_workspace_dir",
    {
      title: "List workspace directory",
      description: "Lists files inside WORKSPACE_ROOT. Path must be relative to the workspace root.",
      inputSchema: {
        path: z.string().default("."),
        max_entries: z.number().int().min(1).max(1000).default(200),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ path: relPath = ".", max_entries = 200 }) => {
      try {
        const target = await resolveInsideWorkspace(relPath);
        return ok(await listDir(target, max_entries));
      } catch (err: unknown) {
        return fail((err as Error).message);
      }
    }
  );

  server.registerTool(
    "search_workspace",
    {
      title: "Search workspace",
      description: "Searches files under WORKSPACE_ROOT by path, content, or both. Uses ripgrep when available and falls back to an optimized JavaScript scanner.",
      inputSchema: {
        query: z.string(),
        include_globs: z.array(z.string()).default(DEFAULT_SEARCH_INCLUDES),
        exclude_globs: z.array(z.string()).default(DEFAULT_SEARCH_EXCLUDES),
        max_results: z.number().int().min(1).max(200).default(50),
        max_files: z.number().int().min(1).max(50000).default(5000),
        max_file_bytes: z.number().int().min(1).max(5_000_000).default(1_000_000),
        case_sensitive: z.boolean().default(false),
        search_mode: z.enum(["path", "content", "both"]).default(DEFAULT_SEARCH_MODE),
      },
      annotations: { readOnlyHint: true },
    },
    async ({
      query,
      include_globs = DEFAULT_SEARCH_INCLUDES,
      exclude_globs = DEFAULT_SEARCH_EXCLUDES,
      max_results = 50,
      max_files = 5000,
      max_file_bytes = 1_000_000,
      case_sensitive = false,
      search_mode = DEFAULT_SEARCH_MODE,
    }) => {
      try {
        return ok(
          await searchWorkspaceFiles({
            query,
            includeGlobs: include_globs,
            excludeGlobs: exclude_globs,
            maxResults: max_results,
            maxFiles: max_files,
            maxFileBytes: max_file_bytes,
            caseSensitive: case_sensitive,
            searchMode: search_mode,
          })
        );
      } catch (err: unknown) {
        return fail((err as Error).message);
      }
    }
  );

  server.registerTool(
    "read_workspace_file",
    {
      title: "Read workspace file",
      description: "Reads a UTF-8 text file inside WORKSPACE_ROOT. Path must be relative to the workspace root.",
      inputSchema: {
        path: z.string(),
        max_bytes: z.number().int().min(1).max(10_000_000).default(200_000),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ path: relPath, max_bytes = 200_000 }) => {
      try {
        const target = await resolveInsideWorkspace(relPath);
        const result = await readTextFile(target, max_bytes);
        return ok({ ok: true, path: target, ...result });
      } catch (err: unknown) {
        return fail((err as Error).message);
      }
    }
  );

  server.registerTool(
    "write_workspace_file",
    {
      title: "Write workspace file",
      description: "Writes UTF-8 content inside WORKSPACE_ROOT only. Creates a backup if replacing an existing file. Uses atomic temp-file replacement.",
      inputSchema: {
        path: z.string(),
        content: z.string(),
        create_backup: z.boolean().default(true),
      },
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ path: relPath, content, create_backup = true }) => {
      try {
        const target = await resolveInsideWorkspace(relPath, { ensureParent: true });
        return ok(await writeTextFile(target, content, create_backup, "write_workspace_file"));
      } catch (err: unknown) {
        return fail((err as Error).message);
      }
    }
  );

  server.registerTool(
    "replace_in_file",
    {
      title: "Replace text in workspace file",
      description: "Patch-style workspace edit. Replaces exact text in a UTF-8 file without resending the whole file.",
      inputSchema: {
        path: z.string(),
        old_text: z.string(),
        new_text: z.string(),
        replace_all: z.boolean().default(false),
        expected_replacements: z.number().int().min(0).optional(),
        create_backup: z.boolean().default(true),
      },
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ path: relPath, old_text, new_text, replace_all = false, expected_replacements, create_backup = true }) => {
      try {
        return ok(
          await replaceInWorkspaceFile({
            relPath,
            oldText: old_text,
            newText: new_text,
            replaceAll: replace_all,
            expectedReplacements: expected_replacements,
            createBackup: create_backup,
          })
        );
      } catch (err: unknown) {
        return fail((err as Error).message);
      }
    }
  );

  server.registerTool(
    "append_to_file",
    {
      title: "Append to workspace file",
      description: "Patch-style workspace edit. Appends UTF-8 content to a file, creating it if needed.",
      inputSchema: {
        path: z.string(),
        content: z.string(),
        create_backup: z.boolean().default(true),
      },
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ path: relPath, content, create_backup = true }) => {
      try {
        return ok(await appendToWorkspaceFile(relPath, content, create_backup));
      } catch (err: unknown) {
        return fail((err as Error).message);
      }
    }
  );

  server.registerTool(
    "insert_after",
    {
      title: "Insert after marker in workspace file",
      description: "Patch-style workspace edit. Inserts content after a marker occurrence in a UTF-8 file.",
      inputSchema: {
        path: z.string(),
        marker: z.string(),
        content: z.string(),
        occurrence: z.number().int().min(1).default(1),
        create_backup: z.boolean().default(true),
      },
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ path: relPath, marker, content, occurrence = 1, create_backup = true }) => {
      try {
        return ok(await insertAfterInWorkspaceFile({ relPath, marker, content, occurrence, createBackup: create_backup }));
      } catch (err: unknown) {
        return fail((err as Error).message);
      }
    }
  );

  server.registerTool(
    "stat_any_path",
    {
      title: "Stat any path",
      description: "Stats an arbitrary local path. This is useful before writing. It returns metadata and sha256 for regular files.",
      inputSchema: {
        path: z.string(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ path: inputPath }) => {
      try {
        return ok(await statPath(abs(inputPath)));
      } catch (err: unknown) {
        return fail((err as Error).message);
      }
    }
  );

  server.registerTool(
    "list_any_dir",
    {
      title: "List any directory",
      description: "Lists an arbitrary local directory. Disabled unless ALLOW_RAW_READ_ANY_FILE is set, or raw write access is enabled for backwards compatibility.",
      inputSchema: {
        path: z.string(),
        max_entries: z.number().int().min(1).max(1000).default(200),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ path: inputPath, max_entries = 200 }) => {
      try {
        assertRawReadEnabled();
        return ok(await listDir(abs(inputPath), max_entries));
      } catch (err: unknown) {
        return fail((err as Error).message);
      }
    }
  );

  server.registerTool(
    "read_any_file",
    {
      title: "Read any file",
      description: "Reads an arbitrary local UTF-8 text file. Disabled unless ALLOW_RAW_READ_ANY_FILE is set, or raw write access is enabled for backwards compatibility.",
      inputSchema: {
        path: z.string(),
        max_bytes: z.number().int().min(1).max(10_000_000).default(200_000),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ path: inputPath, max_bytes = 200_000 }) => {
      try {
        assertRawReadEnabled();
        const target = abs(inputPath);
        const result = await readTextFile(target, max_bytes);
        return ok({ ok: true, path: target, ...result });
      } catch (err: unknown) {
        return fail((err as Error).message);
      }
    }
  );

  server.registerTool(
    "write_any_file",
    {
      title: "Write any local file",
      description:
        "DANGEROUS: raw write_any_file(path, content). Writes UTF-8 content to any absolute or ~/ path the server process can access. Disabled unless ALLOW_RAW_WRITE_ANY_FILE is set. Uses atomic temp-file replacement.",
      inputSchema: {
        path: z.string(),
        content: z.string(),
        create_backup: z.boolean().default(true),
      },
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ path: inputPath, content, create_backup = true }) => {
      try {
        assertRawWriteEnabled();
        const target = abs(inputPath);
        return ok(await writeTextFile(target, content, create_backup, "write_any_file"));
      } catch (err: unknown) {
        return fail((err as Error).message);
      }
    }
  );

  server.registerTool(
    "cleanup_backups",
    {
      title: "Clean up local file MCP backups",
      description: "Applies BACKUP_RETENTION_DAYS and MAX_BACKUP_MB to the backup directory immediately.",
      inputSchema: {},
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        return ok(await cleanupBackups());
      } catch (err: unknown) {
        return fail((err as Error).message);
      }
    }
  );
}

export const RAW_READ_ENABLE_ENV = `ALLOW_RAW_READ_ANY_FILE=${RAW_READ_ENABLE_PHRASE}`;
export const RAW_WRITE_ENABLE_ENV = `ALLOW_RAW_WRITE_ANY_FILE=${RAW_WRITE_ENABLE_PHRASE}`;
