import "dotenv/config";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createLocalFileMcpServer } from "./server.js";

const server = createLocalFileMcpServer();
const transport = new StdioServerTransport();

server.connect(transport).catch((err) => {
  // In stdio MCP servers, never log to stdout. stdout is reserved for JSON-RPC.
  console.error("Failed to start stdio MCP server:", err);
  process.exit(1);
});
