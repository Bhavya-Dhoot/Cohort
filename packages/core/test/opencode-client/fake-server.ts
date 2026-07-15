/**
 * Minimal `node:http` stand-in for `opencode serve`, shaped to match the
 * real endpoints recorded in `src/opencode-client/docs-notes.md`:
 * `GET /global/health`, `POST /session`, `GET /session/:id`,
 * `GET /session/status`, `POST /session/:id/abort`,
 * `POST /session/:id/message`, `GET /event` (SSE).
 *
 * Test-only — lives outside `src/` and is never imported by production
 * code.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeSession {
  id: string;
  directory: string;
  title?: string;
  cost: number;
  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } };
  summary?: { files: number; additions: number; deletions: number };
}

export type FakeSessionStatus = { type: "idle" } | { type: "busy" } | { type: "retry"; attempt: number; message: string; next: number };

export type MessageBehavior =
  | { kind: "completed" }
  | { kind: "error"; name: string; message: string }
  | { kind: "dropped" };

export interface FakeOpencodeServer {
  baseUrl: string;
  port: number;
  sessions: Map<string, FakeSession>;
  statusMap: Map<string, FakeSessionStatus>;
  messageBehavior: MessageBehavior;
  /** Raw event payloads broadcast to active SSE subscribers just before a `/message` response. */
  eventsToEmit: unknown[];
  close(): Promise<void>;
}

let sessionCounter = 0;

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export async function startFakeOpencodeServer(): Promise<FakeOpencodeServer> {
  const sessions = new Map<string, FakeSession>();
  const statusMap = new Map<string, FakeSessionStatus>();
  const sseClients = new Set<ServerResponse>();

  let messageBehavior: MessageBehavior = { kind: "completed" };
  let eventsToEmit: unknown[] = [];

  function broadcast(event: unknown): void {
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of sseClients) client.write(frame);
  }

  async function waitForSseClient(timeoutMs = 500): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (sseClients.size === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const method = req.method ?? "GET";

    // Always drain POST bodies up front, even when unused below, so an
    // unread body never corrupts a keep-alive connection's next request.
    const body = method === "POST" ? await readJsonBody(req) : undefined;

    if (method === "GET" && url.pathname === "/global/health") {
      return sendJson(res, 200, { healthy: true, version: "test" });
    }

    if (method === "GET" && url.pathname === "/event") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive"
      });
      res.write(`data: ${JSON.stringify({ id: "evt_connect", type: "server.connected", properties: {} })}\n\n`);
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }

    if (method === "POST" && url.pathname === "/session") {
      sessionCounter++;
      const id = `ses_test${sessionCounter}`;
      const session: FakeSession = {
        id,
        directory: url.searchParams.get("directory") ?? "",
        title: typeof body?.title === "string" ? body.title : undefined,
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
      };
      sessions.set(id, session);
      return sendJson(res, 200, session);
    }

    if (method === "GET" && url.pathname === "/session/status") {
      const obj: Record<string, FakeSessionStatus> = {};
      for (const [id, status] of statusMap) obj[id] = status;
      return sendJson(res, 200, obj);
    }

    const sessionMatch = url.pathname.match(/^\/session\/([^/]+)(\/.*)?$/);
    if (sessionMatch) {
      const sessionId = sessionMatch[1] as string;
      const sub = sessionMatch[2] ?? "";

      if (method === "GET" && sub === "") {
        const session = sessions.get(sessionId);
        if (!session) return sendJson(res, 404, { name: "NotFoundError", data: { message: "not found" } });
        return sendJson(res, 200, session);
      }

      if (method === "POST" && sub === "/abort") {
        return sendJson(res, 200, true);
      }

      if (method === "POST" && sub === "/message") {
        if (eventsToEmit.length > 0) {
          await waitForSseClient();
          for (const evt of eventsToEmit) broadcast(evt);
          // Give the client's SSE reader a moment to process already-written
          // frames before the response below causes prompt() to abort it.
          await new Promise((resolve) => setTimeout(resolve, 50));
        }

        if (messageBehavior.kind === "dropped") {
          res.destroy();
          return;
        }

        if (messageBehavior.kind === "error") {
          const { name, message } = messageBehavior;
          return sendJson(res, 200, {
            info: { id: "msg_test", sessionID: sessionId, role: "assistant", error: { name, data: { message } } },
            parts: []
          });
        }

        return sendJson(res, 200, {
          info: { id: "msg_test", sessionID: sessionId, role: "assistant" },
          parts: []
        });
      }
    }

    res.writeHead(404);
    res.end();
  }

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      try {
        res.destroy();
      } catch {
        // already gone
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    port: address.port,
    sessions,
    statusMap,
    get messageBehavior() {
      return messageBehavior;
    },
    set messageBehavior(value: MessageBehavior) {
      messageBehavior = value;
    },
    get eventsToEmit() {
      return eventsToEmit;
    },
    set eventsToEmit(value: unknown[]) {
      eventsToEmit = value;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const client of sseClients) client.end();
        server.close((err) => (err ? reject(err) : resolve()));
      })
  };
}
