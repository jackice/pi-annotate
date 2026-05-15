/**
 * @author jackice
 * @date 2026-05-15
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

export interface Annotation {
  id: string;
  type: "comment" | "suggestion" | "issue" | "praise";
  text: string;
  originalText: string;
  range: {
    startOffset: number;
    endOffset: number;
    textPreview: string;
  };
  createdAt: number;
}

interface AnnotationServerOptions {
  markdown: string;
  htmlContent: string;
  mode: "annotate" | "annotate-last";
  sourceInfo?: string;
  gate?: boolean;
}

interface AnnotationServerHandle {
  url: string;
  stop: () => void;
  waitForDecision: () => Promise<{
    action: "feedback" | "approve" | "exit";
    feedback?: string;
    annotations?: Annotation[];
  }>;
}

const MAX_BODY_SIZE = 5 * 1024 * 1024;
const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 200;
const REQUEST_TIMEOUT_MS = 30000;
const STALE_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

class BodyTooLargeError extends Error {
  statusCode = 413;
}

class RequestTimeoutError extends Error {
  statusCode = 408;
}

function requestUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(html);
}

function parseJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      req.destroy();
      reject(new RequestTimeoutError("Request timeout"));
    }, REQUEST_TIMEOUT_MS);

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        clearTimeout(timer);
        req.destroy();
        reject(new BodyTooLargeError("Request body too large"));
        return;
      }
      body += chunk.toString("utf-8");
    });

    req.on("end", () => {
      if (timedOut) return;
      clearTimeout(timer);
      if (body.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reject(new Error(`Invalid JSON: ${message}`));
      }
    });

    req.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function safeInlineJSON(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

export async function startAnnotationServer(
  options: AnnotationServerOptions
): Promise<AnnotationServerHandle> {
  const { markdown, htmlContent, mode, sourceInfo, gate } = options;
  const sessionToken = randomUUID();

  let resolved = false;
  let resolveDecision!: (result: {
    action: "feedback" | "approve" | "exit";
    feedback?: string;
    annotations?: Annotation[];
  }) => void;
  const decisionPromise = new Promise<{
    action: "feedback" | "approve" | "exit";
    feedback?: string;
    annotations?: Annotation[];
  }>((resolve) => {
    resolveDecision = resolve;
  });

  const resolveOnce = (
    result: {
      action: "feedback" | "approve" | "exit";
      feedback?: string;
      annotations?: Annotation[];
    }
  ): void => {
    if (resolved) return;
    resolved = true;
    resolveDecision(result);
  };

  let lastActivity = Date.now();

  const server = createServer(async (req, res) => {
    lastActivity = Date.now();
    try {
      const method = req.method ?? "GET";
      const url = requestUrl(req);

      if (method === "GET" && url.pathname === "/") {
        const inlineData = safeInlineJSON({
          sessionToken,
          mode,
          sourceInfo: sourceInfo ?? null,
          gate: gate ?? false,
          startedAt: Date.now(),
        });
        const html = htmlContent.replace("__ANNOTATE_DATA__", inlineData);
        sendHtml(res, html);
        return;
      }

      if (method === "GET" && url.pathname === "/api/health") {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (method === "GET" && url.pathname === "/api/plan") {
        sendJson(res, 200, {
          plan: markdown,
          mode,
          sourceInfo: sourceInfo ?? null,
          gate: gate ?? false,
        });
        return;
      }

      if (method === "POST" && url.pathname === "/api/feedback") {
        let body: unknown;
        try {
          body = await parseJsonBody(req);
        } catch (err) {
          if (err instanceof BodyTooLargeError) {
            sendJson(res, 413, { ok: false, error: "Request body too large" });
            return;
          }
          if (err instanceof RequestTimeoutError) {
            sendJson(res, 408, { ok: false, error: "Request timeout" });
            return;
          }
          const message = err instanceof Error ? err.message : String(err);
          sendJson(res, 400, { ok: false, error: message });
          return;
        }

        const payload = body as Record<string, unknown>;
        const feedback = typeof payload.feedback === "string" ? payload.feedback : "";
        const annotations = Array.isArray(payload.annotations) ? payload.annotations as Annotation[] : [];

        resolveOnce({
          action: "feedback",
          feedback,
          annotations,
        });

        sendJson(res, 200, { ok: true });
        return;
      }

      if (method === "POST" && url.pathname === "/api/approve") {
        // Body is ignored for approve
        try {
          await parseJsonBody(req);
        } catch {
          // Ignore parse errors — body is optional
        }

        resolveOnce({ action: "approve" });
        sendJson(res, 200, { ok: true });
        return;
      }

      if (method === "POST" && url.pathname === "/api/exit") {
        // Body is ignored for exit
        try {
          await parseJsonBody(req);
        } catch {
          // Ignore parse errors — body is optional
        }

        resolveOnce({ action: "exit" });
        sendJson(res, 200, { ok: true });
        return;
      }

      sendJson(res, 404, { ok: false, error: "Not found" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { ok: false, error: message });
    }
  });

  let port = 0;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      server.removeAllListeners("error");
      port = await new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          if (address && typeof address === "object") {
            resolve(address.port);
          } else {
            reject(new Error("Failed to get server address"));
          }
        });
      });
      lastError = null;
      break;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_RETRIES - 1) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
    }
  }

  if (lastError) {
    throw lastError;
  }

  const url = `http://127.0.0.1:${port}`;

  // Stale timeout: auto-exit when idle for too long
  const staleTimer = setInterval(() => {
    if (resolved) {
      clearInterval(staleTimer);
      return;
    }
    if (Date.now() - lastActivity > STALE_TIMEOUT_MS) {
      resolveOnce({ action: "exit" });
      clearInterval(staleTimer);
    }
  }, 30000);

  const activeConnections = new Set<IncomingMessage>();
  server.on("connection", (socket) => {
    const req = socket as unknown as IncomingMessage;
    activeConnections.add(req);
    socket.on("close", () => {
      activeConnections.delete(req);
    });
  });

  const handle: AnnotationServerHandle = {
    url,
    stop: () => {
      server.close();
    },
    waitForDecision: () => decisionPromise,
  };

  return handle;
}
