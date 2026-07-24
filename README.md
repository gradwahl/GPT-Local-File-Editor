# GPT Local File Editor

A local Model Context Protocol (MCP) file server for ChatGPT. It lets ChatGPT
read and edit files inside a workspace you choose, with optional dangerous
raw file access guarded by environment variables.

## What is it?

This project runs an MCP server on your machine. ChatGPT connects to it through
the HTTP endpoint:

```text
http://127.0.0.1:3333/mcp
```

If you expose that endpoint through the OpenAI tunnel client, keep
`MCP_LOCAL_TOKEN` private and use a long random value.

## OpenAI setup

Create an OpenAI API key from the
[API keys page](https://platform.openai.com/api-keys). The full secret is only
shown once, so save it somewhere private.

Create or manage a Secure MCP Tunnel from
[Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels).
Copy the tunnel id for the tunnel you want to use.

In ChatGPT on the web, open Settings -> Plugins or go to
[chatgpt.com/plugins](https://chatgpt.com/plugins). Add a developer-mode app,
choose Tunnel as the connection type, then select your tunnel from the list or
paste the tunnel id. The tunnel must be selected there before ChatGPT can use
this local MCP server.

## Build it

Install Node.js 20 or newer, then run:

```powershell
npm install
npm run build
```

The build output is written to `dist/`. It is not committed; each user builds
it locally.

## Run it

Start the file server:

```powershell
npm run start:http
```

For a guided Windows prompt, run:

```powershell
.\1-Run File Server.bat
```

Start the tunnel client in a second terminal after the server is running:

```powershell
.\2-Run Tunnel Client.bat
```

The tunnel client executable is not included in this repository. Put your
`tunnel-client.exe` in the project root before running the tunnel batch file.

## Where do I enter the tunnel id?

Get it from
[Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels),
then select or paste the same tunnel in ChatGPT web Plugins.

Run `2-Run Tunnel Client.bat`. It prompts for:

```text
Enter tunnel id:
```

You can also set it yourself before running the client:

```powershell
$env:CONTROL_PLANE_TUNNEL_ID="your-tunnel-id"
```

## Where do I enter the API key?

Get it from the [API keys page](https://platform.openai.com/api-keys).

Run `2-Run Tunnel Client.bat`. It prompts for:

```text
Enter OpenAI API key:
```

You can also set it yourself before running the client:

```powershell
$env:CONTROL_PLANE_API_KEY="your-api-key"
```

## Where do I enter the local MCP token?

Run `1-Run File Server.bat`. It prompts for:

```text
Enter MCP local token:
```

Or create a local `.env` file from `.env.example` and set:

```env
MCP_LOCAL_TOKEN=your-long-random-secret
```

Do not commit `.env`, `.mcp-local-token`, `.mcp-server-port`,
`tunnel-client.exe`, `dist/`, or `node_modules/`.
