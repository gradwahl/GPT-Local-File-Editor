# GPT Local File Editor

A local Model Context Protocol (MCP) file server for ChatGPT. It lets ChatGPT
read and edit files inside a workspace you choose, with optional raw file access
guarded by environment variables.

## Connection options

This repository is source-only. Users install dependencies and build `dist/`
locally.

The way ChatGPT connects to this MCP server

- **ChatGPT Chat, fastest path:** Secure MCP Tunnel -> tunnel client -> local
  STDIO server.

## Prerequisites

- Node.js 20 or newer
- An OpenAI API key for the tunnel client
- A Secure MCP Tunnel ID from
  [Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels)
- `start-tunnel.exe` from the
  [OpenAI tunnel-client releases](https://github.com/openai/tunnel-client/releases)
- Optional but recommended:
  [ripgrep](https://github.com/BurntSushi/ripgrep) for fast search

Put `start-tunnel.exe` in the project root. The STDIO launcher copies it to
`tunnel-client.exe` automatically when needed.

## Install and build

```powershell
git clone https://github.com/your-name/GPT-Local-File-Editor.git
cd GPT-Local-File-Editor
npm install
npm run build
```

The build output is written to `dist/`. It is ignored by Git and should not be
committed.

## Configure `.env`

Copy `.env.example` to `.env` and edit the local values:

```powershell
copy .env.example .env
```

At minimum, set the workspace folder ChatGPT is allowed to edit:

```env
WORKSPACE_ROOT=C:\Users\YourName\Documents\ChatGPT-editable
```

Raw arbitrary-path reads are enabled with this exact phrase:

```env
ALLOW_RAW_READ_ANY_FILE=I_UNDERSTAND_THIS_CAN_READ_PRIVATE_FILES
```

For the HTTP tunnel path, also set or enter a private local token:

```env
MCP_LOCAL_TOKEN=change-me-to-a-long-random-secret
```

Search uses ripgrep when available:

```env
SEARCH_USE_RIPGREP=true
SEARCH_USE_RIPGREP_FILES=true
SEARCH_INDEX_CACHE_TTL_MS=300000
```

If the server cannot find `rg` on PATH, set:

```env
RIPGREP_PATH=C:\full\path\to\rg.exe
```

## ChatGPT Chat: fastest STDIO tunnel

Use this for the lowest-latency ChatGPT Chat setup:

```text
ChatGPT Chat -> Secure MCP Tunnel -> tunnel-client -> node dist/src/stdio.js
```

Run:

```powershell
& ".\Run Tunnel Client STDIO.bat"
```

The script prompts for your OpenAI API key and tunnel ID, saves them locally in
`keys.bat`, builds the project if `dist/` is missing, and starts the tunnel
client with:

```text
--mcp.command "command=node dist/src/stdio.js,channel=main"
```

You do not need to start the local HTTP server in this mode.

In ChatGPT Chat, add or manage the developer-mode MCP app from
[chatgpt.com/plugins](https://chatgpt.com/plugins) or ChatGPT settings, choose
Tunnel as the connection type, and select or paste the same tunnel ID.

## ChatGPT Chat: manual HTTP tunnel

Use this path if you specifically want the local HTTP MCP server:

```text
ChatGPT Chat -> Secure MCP Tunnel -> tunnel-client -> http://127.0.0.1:3333/mcp
```

Start the file server:

```powershell
npm run start:http
```

Then start `tunnel-client.exe` in a second terminal and point it at the local
HTTP endpoint:

```powershell
.\tunnel-client.exe run --control-plane.api-key "env:CONTROL_PLANE_API_KEY" --control-plane.tunnel-id "your-tunnel-id" --mcp.server-url "url=http://127.0.0.1:3333/mcp,channel=main" --mcp.extra-headers "Authorization: Bearer your-mcp-local-token"
```

Set `CONTROL_PLANE_API_KEY` first, or replace the `env:CONTROL_PLANE_API_KEY`
reference with another supported secret reference. The `MCP_LOCAL_TOKEN` value
is a secret you create yourself; it is not supplied by OpenAI.

## ChatGPT Desktop / Codex

Use this only for the ChatGPT desktop app's Codex MCP server settings. It does
not apply to normal ChatGPT Chat.

Add an MCP server with:

```text
Name: local-file-editor
Type: STDIO
Command: node
Arguments: dist/src/stdio.js
Working directory: C:\path\to\GPT-Local-File-Editor
```

Restart ChatGPT Desktop, then open a Codex task and type `/mcp` to confirm the
server is connected.

## Useful commands

Build:

```powershell
npm run build
```

Run the HTTP server directly:

```powershell
npm run start:http
```

Run the STDIO server directly for local MCP clients:

```powershell
npm run start:stdio
```

Check configuration:

```powershell
npm run doctor
```

## Security and publishing

Do not commit local secrets or generated artifacts. These are ignored by Git:

```text
.env
.mcp-local-token
.mcp-server-port
keys.bat
keys.txt
tunnel-client.exe
dist/
node_modules/
```

Delete `keys.bat` if you want to reset saved local credentials. If an API key
has ever been committed, pasted into an issue, shared in logs, or exposed in a
terminal transcript, revoke it and create a new one.

Raw write access is intentionally disabled unless you set:

```env
ALLOW_RAW_WRITE_ANY_FILE=I_UNDERSTAND_THIS_CAN_DESTROY_FILES
```

Leave raw writes disabled unless you understand the risk.
