import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const RAW_READ_ENABLE_PHRASE = "I_UNDERSTAND_THIS_CAN_READ_PRIVATE_FILES";
const RAW_WRITE_ENABLE_PHRASE = "I_UNDERSTAND_THIS_CAN_DESTROY_FILES";

function expandHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) return path.join(os.homedir(), input.slice(2));
  return input;
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

    result[name] = path.resolve(expandHome(value));
  }

  return result;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  const normalized = raw.toLowerCase().trim();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function configuredWorkspace(): { source: string; path: string; named: Record<string, string> } {
  const named = parseNamedWorkspaces();
  const defaultWorkspace = process.env.DEFAULT_WORKSPACE || "";

  if (defaultWorkspace && named[defaultWorkspace]) {
    return { source: `named:${defaultWorkspace}`, path: named[defaultWorkspace], named };
  }

  const workspace = path.resolve(expandHome(process.env.WORKSPACE_ROOT || "~/ChatGPT-editable"));
  return { source: process.env.WORKSPACE_ROOT ? "WORKSPACE_ROOT" : "default", path: workspace, named };
}

async function main(): Promise<void> {
  const workspace = configuredWorkspace();
  const home = path.resolve(expandHome(process.env.CHATGPT_FILE_MCP_HOME || "~/.chatgpt-local-file-mcp"));
  const rawWriteEnabled = process.env.ALLOW_RAW_WRITE_ANY_FILE === RAW_WRITE_ENABLE_PHRASE;
  const rawReadEnabled = process.env.ALLOW_RAW_READ_ANY_FILE === RAW_READ_ENABLE_PHRASE || rawWriteEnabled;
  const backupRetentionDays = Number.parseInt(process.env.BACKUP_RETENTION_DAYS || "0", 10);
  const maxBackupMb = Number.parseInt(process.env.MAX_BACKUP_MB || "0", 10);
  const sessionTtlMs = Number.parseInt(process.env.MCP_SESSION_TTL_MS || "1800000", 10);
  const searchIndexCacheTtlMs = Number.parseInt(process.env.SEARCH_INDEX_CACHE_TTL_MS || "300000", 10);
  const searchConcurrency = Number.parseInt(process.env.SEARCH_CONCURRENCY || "16", 10);
  const commandMaxOutputBytes = Number.parseInt(process.env.COMMAND_MAX_OUTPUT_BYTES || "65536", 10);

  await fs.mkdir(workspace.path, { recursive: true });
  await fs.mkdir(path.join(home, "backups"), { recursive: true });
  await fs.mkdir(path.join(home, "audit"), { recursive: true });

  console.log("chatgpt-local-file-mcp doctor");
  console.log(`Node: ${process.version}`);
  console.log(`Workspace root: ${workspace.path}`);
  console.log(`Workspace source: ${workspace.source}`);
  console.log(`Named workspaces: ${Object.keys(workspace.named).length ? JSON.stringify(workspace.named) : "none"}`);
  console.log(`Tool home: ${home}`);
  console.log(`Raw read_any_file/list_any_dir enabled: ${rawReadEnabled}`);
  console.log(`Raw write_any_file enabled: ${rawWriteEnabled}`);
  console.log(`Query-token auth enabled: ${process.env.ALLOW_QUERY_TOKEN_AUTH === "true"}`);
  console.log(`HTTP session TTL ms: ${Number.isFinite(sessionTtlMs) ? sessionTtlMs : 1800000}`);
  console.log(`Backup retention days: ${Number.isFinite(backupRetentionDays) ? backupRetentionDays : 0}`);
  console.log(`Max backup MB: ${Number.isFinite(maxBackupMb) ? maxBackupMb : 0}`);
  console.log(`Search uses ripgrep: ${envBool("SEARCH_USE_RIPGREP", true)}`);
  console.log(`Search index uses rg --files: ${envBool("SEARCH_USE_RIPGREP_FILES", envBool("SEARCH_USE_RIPGREP", true))}`);
  console.log(`Search index cache TTL ms: ${Number.isFinite(searchIndexCacheTtlMs) ? searchIndexCacheTtlMs : 300000}`);
  console.log(`Search concurrency: ${Number.isFinite(searchConcurrency) ? searchConcurrency : 16}`);
  console.log(`Command max output bytes per stream: ${Number.isFinite(commandMaxOutputBytes) ? commandMaxOutputBytes : 65536}`);
  console.log(`Default write backups: ${envBool("WRITE_CREATE_BACKUP_DEFAULT", true)}`);
  console.log(`Write SHA-256 hashes: ${envBool("WRITE_COMPUTE_SHA256", true)}`);

  if (process.env.ALLOW_QUERY_TOKEN_AUTH === "true") {
    console.warn("Warning: query-token auth is enabled. Use this only for local testing.");
  }
  if (rawWriteEnabled) {
    console.warn("Warning: raw write_any_file is enabled. Keep backups enabled and avoid running as admin/root.");
  }

  console.log("OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
