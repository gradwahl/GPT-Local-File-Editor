# GPT Local File Editor

A local Model Context Protocol (MCP) file server for ChatGPT. It lets ChatGPT
read and edit files inside a workspace you choose. Broader raw file access is
disabled by default and guarded by explicit environment variables.

This repository is source-only. It includes a Windows STDIO tunnel launcher,
but it does not include generated build output, downloaded tunnel-client
binaries, API keys, tunnel IDs, local tokens, or saved credential files.

## Connection Options

The server supports two local MCP transports:

- HTTP streamable MCP at `http://127.0.0.1:3333/mcp`
- STDIO MCP through `node dist/src/stdio.js`

For ChatGPT web, use a Secure MCP Tunnel. Create or manage tunnels from
[Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels),
then connect the tunnel from ChatGPT Settings -> Plugins or
[chatgpt.com/plugins](https://chatgpt.com/plugins).

## Prerequisites

- Node.js 20 or newer
- An OpenAI API key from the
  [API keys page](https://platform.openai.com/api-keys), with permission to use
  the target tunnel
- A Secure MCP Tunnel ID from
  [Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels)
- `start-tunnel.exe` from the
  [OpenAI tunnel-client releases](https://github.com/openai/tunnel-client/releases),
  placed in the project root for the Windows launcher to copy locally, or a
  separately installed `tunnel-client` on PATH
- Optional: [ripgrep](https://github.com/BurntSushi/ripgrep) for faster search

Keep the API key, tunnel ID, local `.env`, generated `keys.bat`, and
tunnel-client binary outside source control.

## Install And Build

```powershell
npm install
npm run build
```

The build output is written to `dist/`. It is generated locally and ignored by
Git.

Create a local `.env` from the example:

```powershell
Copy-Item .env.example .env
```

At minimum, set the workspace folder ChatGPT may read and edit:

```env
WORKSPACE_ROOT=C:\Users\YourName\Documents\ChatGPT-editable
```

For HTTP tunnel mode, also set a local bearer token. This is your own local
secret, not an OpenAI-provided value:

```env
MCP_LOCAL_TOKEN=replace-with-a-long-random-local-token
```

## Check Setup

```powershell
npm run doctor
```

The doctor script checks the configured workspace, backup directory, raw
read/write flags, search settings, and write-safety settings.

## ChatGPT Web: STDIO Tunnel

STDIO mode is the simplest tunnel path because it does not require starting the
local HTTP server or configuring an HTTP bearer token.

```text
ChatGPT web -> Secure MCP Tunnel -> tunnel-client -> node dist/src/stdio.js
```

On Windows, the included launcher can prompt for the API key and tunnel ID,
build the project if needed, and start `tunnel-client`:

```powershell
& ".\Run Tunnel Client STDIO.bat"
```

The launcher writes saved local credentials to `keys.bat`. That file is ignored
by Git and must not be committed.

You can also run the same STDIO tunnel command manually from this project root
after `npm run build`:

```powershell
$env:CONTROL_PLANE_API_KEY="your-api-key"
$env:CONTROL_PLANE_TUNNEL_ID="your-tunnel-id"

tunnel-client run --control-plane.api-key "env:CONTROL_PLANE_API_KEY" --control-plane.tunnel-id "$env:CONTROL_PLANE_TUNNEL_ID" --mcp.command "command=node dist/src/stdio.js,channel=main"
```

The STDIO server still reads this project's local `.env`, so `WORKSPACE_ROOT`,
named workspaces, backups, search settings, and raw access flags still apply.

## ChatGPT Web: HTTP Tunnel

Use HTTP mode if you specifically want the local HTTP MCP endpoint:

```text
ChatGPT web -> Secure MCP Tunnel -> tunnel-client -> http://127.0.0.1:3333/mcp
```

Start the local server:

```powershell
npm run start:http
```

It listens on:

```text
http://127.0.0.1:3333/mcp
```

Health/status is available at:

```text
http://127.0.0.1:3333/health
```

In a second terminal, from this project root:

```powershell
$env:CONTROL_PLANE_API_KEY="your-api-key"
$env:CONTROL_PLANE_TUNNEL_ID="your-tunnel-id"
$env:MCP_LOCAL_TOKEN="replace-with-the-same-token-from-dotenv"

tunnel-client run --control-plane.api-key "env:CONTROL_PLANE_API_KEY" --control-plane.tunnel-id "$env:CONTROL_PLANE_TUNNEL_ID" --mcp.server-url "http://127.0.0.1:3333/mcp" --mcp.extra-headers "Authorization: Bearer env:MCP_LOCAL_TOKEN"
```

`MCP_LOCAL_TOKEN` must match the value in your local `.env` file so
`tunnel-client` can authenticate to the local HTTP server.

## Useful Commands

```powershell
npm run build
npm run start:http
npm run start:stdio
npm run doctor
```

## Tools

Workspace-safe tools are enabled by default:

```text
get_file_tool_status
set_workspace_root
switch_workspace
list_workspace_dir
search_workspace
read_workspace_file
read_workspace_files
list_workspace_tree
write_workspace_file
replace_in_file
append_to_file
insert_after
stat_any_path
cleanup_backups
```

Terminal/development tools are also available:

```text
run_command
run_commands
check_project
start_process
read_process
write_process
stop_process
list_processes
```

### Bounded command output

`run_command` and every entry in `run_commands` retain a bounded amount of
ANSI-stripped stdout and stderr so huge test/build logs do not become huge MCP
responses. The default is 65,536 bytes per stream and can be changed with:

```env
COMMAND_MAX_OUTPUT_BYTES=65536
```

When output exceeds the limit, the buffer preserves the beginning and the tail.
With the 64 KiB default it keeps about 8 KiB from the beginning and 48 KiB from
the end, leaving room for the truncation marker while keeping the entire returned
stream below the configured cap. Results include `stdout_truncated` /
`stderr_truncated` plus total, retained, and omitted byte counts. A per-command
`max_output_bytes` argument can override the environment default.

`run_command` and `run_commands` use `cross-spawn` and take an executable plus an
argument array. Call tools such as `npm`, `npx`, `pnpm`, `git`, `node`, and
`python` directly instead of wrapping them in PowerShell, `cmd.exe`, or another
shell. The executor uses `shell: false`; on Windows, `cross-spawn` handles
PATHEXT, shebangs, and `.cmd`/`.bat` shims internally. For example:

```json
{
  "command": "npm",
  "args": ["test"],
  "cwd": ".",
  "timeout_ms": 120000
}
```

Command working directories must stay inside the active workspace. The active
workspace's `node_modules/.bin` is prepended to `PATH` for command execution.

Terminal stdout and stderr are ANSI-sanitized before buffering and before they are
returned through MCP. Color/style sequences such as `ESC[31m`, OSC hyperlinks/title
sequences, and related terminal control strings are removed. The sanitizer is
streaming, so an escape sequence split across multiple process-output chunks is still
removed cleanly. This also means ANSI bytes do not consume the configured output
buffer limits.

### One-call project verification with `check_project`

After editing code, `check_project` can detect configured verification and run it
in one MCP round trip instead of first discovering scripts and then issuing separate
terminal calls. Detection is intentionally conservative:

- **Node.js:** runs only package scripts that actually exist: `test`, a known
  typecheck script (`typecheck`, `type-check`, `check-types`, or `check:types`),
  and `build`. The package manager comes from `packageManager` or the project
  lockfile (`pnpm`, Yarn, Bun, or npm).
- **Python:** runs `pytest`, Ruff, and/or mypy only when their configuration or
  dependency is detected. A project `.venv`/`venv` Python is preferred when present.
- **Rust:** `Cargo.toml` enables `cargo check` and `cargo test`.
- **Go:** `go.mod` enables `go test ./...`.

Example:

```json
{
  "cwd": ".",
  "mode": "sequential",
  "stop_on_error": false
}
```

The default is to continue through all detected checks so a single response reports
as many failures as possible. Set `stop_on_error=true` for fail-fast sequential
verification, or `mode="parallel"` when the project's checks are known to be safe
to run concurrently. `dry_run=true` returns the detected plan without launching
anything. Per-check stdout and stderr default to 8 KiB each, using the same
ANSI-stripped head+tail buffering as `run_command`, so the compound response remains
compact while retaining useful failure context.

### Batch commands with `run_commands`

When several commands are known up front, use `run_commands` so ChatGPT sends one
MCP request and receives one combined result instead of paying a round trip per
command. Sequential mode is intended for dependent verification pipelines:

```json
{
  "commands": [
    { "command": "git", "args": ["status", "--short"] },
    { "command": "npm", "args": ["test"] },
    { "command": "npm", "args": ["run", "build"] }
  ],
  "mode": "sequential",
  "stop_on_error": true
}
```

With `stop_on_error=true`, sequential execution stops at the first failed command
and reports the remaining commands as skipped. Use parallel mode for independent
diagnostics that can safely run at the same time:

```json
{
  "commands": [
    { "command": "node", "args": ["--version"] },
    { "command": "git", "args": ["status", "--short"] },
    { "command": "npm", "args": ["--version"] },
    { "command": "python", "args": ["--version"] }
  ],
  "mode": "parallel",
  "stop_on_error": false
}
```

Parallel mode starts all commands concurrently. Because they are already running,
`stop_on_error` cannot cancel sibling commands in parallel mode. Results retain
the same indexes/order as the input command list and include batch counts, timing,
first-failure index, and skipped-command information.

### Persistent processes

`start_process` is intended for long-running development servers, watchers, and
interactive stdin/stdout workflows. The child stays alive inside the running MCP
server and is tracked in an in-memory process map. Start it once and keep the
returned `process_id` while editing files:

```json
{
  "command": "npm",
  "args": ["run", "dev"],
  "cwd": "."
}
```

The response includes `process_id`, `pid`, status, command/args, and unread
stdout/stderr byte counts. Output is ANSI-cleaned and kept in bounded in-memory
buffers. `read_process` consumes only output that has arrived since previous
reads:

```json
{
  "process_id": "proc_0123456789ab",
  "wait_ms": 5000
}
```

`wait_ms` is optional (maximum 30 seconds). When there is no unread output yet,
it can wait for the next stdout/stderr chunk or process exit, which avoids rapid
MCP polling while a watcher rebuilds. If more output remains than one read can
return, `hasMoreOutput` is true.

Use `write_process` to send stdin without restarting the process, and
`stop_process` to terminate it. `stop_process` first requests a graceful process-
tree shutdown, waits up to `grace_ms` (3 seconds by default), then force-kills the
tree if `force=true` and it is still alive. `list_processes` reports both active
and exited managed processes; pass `include_exited=false` to show only active
ones.

> **Terminal security:** workspace-relative `cwd` validation is not a command
> sandbox. A program launched by these tools runs with the same operating-system
> permissions as the MCP server and can access paths outside `WORKSPACE_ROOT`.
> Treat terminal access as full command execution on the host account.

Raw local-file tools are disabled unless explicitly enabled:

```text
list_any_dir
read_any_file
write_any_file
```

Enable raw reads only if you understand the privacy risk:

```env
ALLOW_RAW_READ_ANY_FILE=I_UNDERSTAND_THIS_CAN_READ_PRIVATE_FILES
```

Enable raw writes only if you understand the data-loss risk:

```env
ALLOW_RAW_WRITE_ANY_FILE=I_UNDERSTAND_THIS_CAN_DESTROY_FILES
```

Raw write access also enables raw reads for backwards compatibility.

## Performance And Safety

Search uses ripgrep when available:

```env
SEARCH_USE_RIPGREP=true
SEARCH_USE_RIPGREP_FILES=true
SEARCH_INDEX_CACHE_TTL_MS=300000
SEARCH_CONCURRENCY=16
```

If the server cannot find `rg` on PATH, set:

```env
RIPGREP_PATH=C:\full\path\to\rg.exe
```

Writes create backups and compute before/after SHA-256 hashes by default:

```env
WRITE_CREATE_BACKUP_DEFAULT=true
WRITE_COMPUTE_SHA256=true
```

Backups and audit logs default to:

```env
CHATGPT_FILE_MCP_HOME=~/.chatgpt-local-file-mcp
```

## Do Not Commit

Do not commit local secrets, generated output, dependencies, or downloaded
binaries. These are ignored by Git:

```text
.env
.env.*
.mcp-local-token
.mcp-server-port
keys.bat
keys.txt
*.key
*.pem
*.p12
*.pfx
tunnel-client.exe
start-tunnel.exe
dist/
node_modules/
*.tgz
*.zip
```

If an API key, local token, or tunnel credential is ever committed, pasted into
an issue, shared in logs, or exposed in a terminal transcript, revoke it and
create a new one.
