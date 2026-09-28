import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerFileTools } from "./fileTools.js";
import { registerTerminalTools } from "./terminalTools.js";
import { registerProjectTools } from "./projectTools.js";

export function createLocalFileMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: "chatgpt-local-file-mcp",
      version: "0.1.0",
    },
    {
      instructions:
        "Local filesystem and development tools. Prefer check_project after code edits when the project has configured verification; it detects and runs relevant checks in one MCP call. For ad-hoc terminal work, use run_command/run_commands for normal executables such as npm, node, git, java, javac, python, and npx. On Windows, use run_windows_command for .bat/.cmd scripts, CMD built-ins such as dir/copy/del/type/set, or command lines that need &&, ||, pipes, or redirection. For direct programs, pass the executable and argv separately (for example command=\"npm\", args=[\"test\"]). When two or more direct commands can be decided up front, prefer ONE run_commands call over multiple run_command calls to reduce MCP round trips. Use mode=\"parallel\" for independent diagnostics and mode=\"sequential\" with stop_on_error=true for dependent build/test pipelines. Command cwd is confined to the active workspace, but commands themselves are NOT sandboxed and run with the MCP process user\'s OS permissions. Use start_process once for long-running dev servers/watchers, keep the returned process_id, and use read_process for incremental output instead of restarting the process. Prefer read_process wait_ms when waiting for the next build/log event rather than repeatedly polling. For interactive REPLs/shells, read_process prompt_detection=auto waits until a recognized prompt when appropriate; use verbose_timing=true when diagnosing process latency or prompt behavior. Before destructive filesystem writes or risky commands, describe the intended change.",
    }
  );

  registerFileTools(server);
  registerTerminalTools(server);
  registerProjectTools(server);
  return server;
}
