import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerFileTools } from "./fileTools.js";

export function createLocalFileMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: "chatgpt-local-file-mcp",
      version: "0.1.0",
    },
    {
      instructions:
        "Local filesystem tools. Prefer workspace-scoped tools unless the user explicitly asks for raw any-path access. Before destructive writes, describe the target path and intended change. Raw write_any_file is intentionally dangerous and only available when the server operator enables it.",
    }
  );

  registerFileTools(server);
  return server;
}
