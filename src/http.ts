import "dotenv/config";
import express, { type Request, type Response, type NextFunction } from "express";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createLocalFileMcpServer } from "./server.js";

const PORT = Number.parseInt(process.env.PORT || "3333", 10);
const HOST = process.env.HOST || "127.0.0.1";
const TOKEN = process.env.MCP_LOCAL_TOKEN || "";
const ALLOW_QUERY_TOKEN_AUTH = process.env.ALLOW_QUERY_TOKEN_AUTH === "true";
const SESSION_TTL_MS = Math.max(60_000, Number.parseInt(process.env.MCP_SESSION_TTL_MS || "1800000", 10));
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "https://chatgpt.com,https://chat.openai.com")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);

type TransportSession = {
  transport: StreamableHTTPServerTransport;
  createdAt: number;
  lastSeenAt: number;
};

function checkAuth(req: Request, res: Response, next: NextFunction): void {
  if (!TOKEN) {
    next();
    return;
  }

  const auth = req.header("authorization") || "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const queryToken = typeof req.query.token === "string" ? req.query.token : "";

  if (bearer === TOKEN) {
    next();
    return;
  }

  if (queryToken) {
    if (!ALLOW_QUERY_TOKEN_AUTH) {
      res.status(401).json({
        error:
          "Query-token auth is disabled. Use Authorization: Bearer <token>, or set ALLOW_QUERY_TOKEN_AUTH=true only for local testing.",
      });
      return;
    }

    if (queryToken === TOKEN) {
      next();
      return;
    }
  }

  res.status(401).json({ error: "Missing or invalid MCP_LOCAL_TOKEN." });
}

function checkOrigin(req: Request, res: Response, next: NextFunction): void {
  const origin = req.header("origin");
  if (!origin || ALLOWED_ORIGINS.includes("*") || ALLOWED_ORIGINS.includes(origin)) {
    next();
    return;
  }
  res.status(403).json({ error: `Origin not allowed: ${origin}` });
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "50mb" }));
app.use(checkOrigin);

const transports: Record<string, TransportSession> = {};

function rememberTransport(sessionId: string, transport: StreamableHTTPServerTransport): void {
  const now = Date.now();
  transports[sessionId] = { transport, createdAt: now, lastSeenAt: now };
}

function getTransport(sessionId: string | undefined): StreamableHTTPServerTransport | null {
  if (!sessionId) return null;
  const session = transports[sessionId];
  if (!session) return null;
  session.lastSeenAt = Date.now();
  return session.transport;
}

async function cleanupIdleSessions(): Promise<void> {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [sessionId, session] of Object.entries(transports)) {
    if (session.lastSeenAt >= cutoff) continue;

    try {
      await session.transport.close();
    } catch (err) {
      console.error(`Error closing idle transport ${sessionId}:`, err);
    }
    delete transports[sessionId];
  }
}

const cleanupTimer = setInterval(() => {
  void cleanupIdleSessions();
}, Math.min(SESSION_TTL_MS, 60_000));
cleanupTimer.unref();

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    name: "chatgpt-local-file-mcp",
    endpoint: "/mcp",
    activeSessions: Object.keys(transports).length,
    sessionTtlMs: SESSION_TTL_MS,
    queryTokenAuthEnabled: ALLOW_QUERY_TOKEN_AUTH,
  });
});

async function handleMcpPost(req: Request, res: Response): Promise<void> {
  const sessionId = req.header("mcp-session-id") || undefined;

  try {
    let transport = getTransport(sessionId);

    if (!transport && !sessionId && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => {
          if (transport) rememberTransport(newSessionId, transport);
        },
      });

      transport.onclose = () => {
        const closedSessionId = transport?.sessionId;
        if (closedSessionId) delete transports[closedSessionId];
      };

      const server = createLocalFileMcpServer();
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    if (!transport) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: no valid session ID or initialize request." },
        id: null,
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP POST error:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error." },
        id: null,
      });
    }
  }
}

async function handleMcpGet(req: Request, res: Response): Promise<void> {
  const sessionId = req.header("mcp-session-id") || undefined;
  const transport = getTransport(sessionId);
  if (!transport) {
    res.status(400).send("Invalid or missing MCP session ID.");
    return;
  }
  await transport.handleRequest(req, res);
}

async function handleMcpDelete(req: Request, res: Response): Promise<void> {
  const sessionId = req.header("mcp-session-id") || undefined;
  const transport = getTransport(sessionId);
  if (!transport) {
    res.status(400).send("Invalid or missing MCP session ID.");
    return;
  }
  await transport.handleRequest(req, res);
}

app.post("/mcp", checkAuth, (req, res) => void handleMcpPost(req, res));
app.get("/mcp", checkAuth, (req, res) => void handleMcpGet(req, res));
app.delete("/mcp", checkAuth, (req, res) => void handleMcpDelete(req, res));

const server = app.listen(PORT, HOST, () => {
  console.error(`chatgpt-local-file-mcp listening at http://${HOST}:${PORT}/mcp`);
  if (!TOKEN) {
    console.error("Warning: MCP_LOCAL_TOKEN is not set. Set one before exposing this over a tunnel.");
  }
  if (ALLOW_QUERY_TOKEN_AUTH) {
    console.error("Warning: query-token auth is enabled. Use this only for local testing.");
  }
});

async function shutdown(): Promise<void> {
  console.error("Shutting down chatgpt-local-file-mcp...");
  clearInterval(cleanupTimer);
  server.close();
  for (const [sessionId, session] of Object.entries(transports)) {
    try {
      await session.transport.close();
    } catch (err) {
      console.error(`Error closing transport ${sessionId}:`, err);
    }
    delete transports[sessionId];
  }
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
