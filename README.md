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
