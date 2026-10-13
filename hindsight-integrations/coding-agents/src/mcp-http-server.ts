#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { authenticate, loadRemoteConfig } from "./remote/config";
import { buildRemoteServer, createRemoteClient } from "./remote/tools";
import { pendingRemoteConclusions, retryConclusions } from "./core/conclusions";
import { policyRevision } from "./remote/config";

const MAX_BODY_BYTES = 256 * 1024;
function respond(res: ServerResponse, status: number, message: string) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    ...(status === 401 ? { "WWW-Authenticate": "Bearer" } : {}),
    ...(status === 429 ? { "Retry-After": "1" } : {}),
  });
  res.end(JSON.stringify({ error: message }));
}
async function readBody(req: IncomingMessage): Promise<unknown> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (!Number.isFinite(declared) || declared > MAX_BODY_BYTES) throw new Error("body_too_large");
  const parts: Buffer[] = [];
  let bytes = 0;
  for await (const part of req) {
    const buf = Buffer.from(part);
    bytes += buf.length;
    if (bytes > MAX_BODY_BYTES) throw new Error("body_too_large");
    parts.push(buf);
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  } catch {
    throw new Error("invalid_json");
  }
}

export async function startRemoteServer(configPath: string) {
  const startup = loadRemoteConfig(configPath);
  const shutdown = new AbortController();
  const active = new Set<AbortController>();
  let inFlightTools = 0;
  const perPrincipal = new Map<string, number>();
  const http = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    let config;
    try {
      config = loadRemoteConfig(configPath);
    } catch {
      return respond(res, 503, "configuration_unavailable");
    }
    const origin = new URL(config.publicOrigin);
    // Reverse proxies may forward the public hostname without its external port.
    if (
      ![origin.host.toLowerCase(), origin.hostname.toLowerCase()].includes(
        req.headers.host?.toLowerCase() ?? ""
      )
    )
      return respond(res, 403, "host_not_allowed");
    if (req.headers.origin && req.headers.origin !== origin.origin)
      return respond(res, 403, "origin_not_allowed");
    if (req.url === "/health" && req.method === "GET") return respond(res, 200, "ok");
    if (req.url !== "/mcp") return respond(res, 404, "not_found");
    const principal = authenticate(config, req.headers.authorization);
    if (!principal) return respond(res, 401, "unauthorized");
    if (req.method !== "POST") return respond(res, 405, "method_not_allowed");
    let body: unknown;
    try {
      body = await readBody(req);
    } catch (e) {
      return respond(
        res,
        e instanceof Error && e.message === "body_too_large" ? 413 : 400,
        "invalid_request_body"
      );
    }
    if (Array.isArray(body)) return respond(res, 400, "batch_requests_not_supported");
    const isToolCall =
      !!body && typeof body === "object" && "method" in body && body.method === "tools/call";
    let leased = false;
    if (isToolCall) {
      const count = perPrincipal.get(principal.id) ?? 0;
      if (inFlightTools >= config.maxConcurrentTools || count >= config.maxConcurrentToolsPerClient)
        return respond(res, 429, "tool_concurrency_exceeded");
      inFlightTools++;
      perPrincipal.set(principal.id, count + 1);
      leased = true;
    }
    const release = () => {
      if (!leased) return;
      leased = false;
      inFlightTools--;
      const remaining = (perPrincipal.get(principal.id) ?? 1) - 1;
      if (remaining > 0) perPrincipal.set(principal.id, remaining);
      else perPrincipal.delete(principal.id);
    };
    // One server and transport per HTTP request: no shared caller session, bank or credentials.
    const cancel = new AbortController();
    active.add(cancel);
    const signal = AbortSignal.any([shutdown.signal, cancel.signal, AbortSignal.timeout(345000)]);
    const server = buildRemoteServer(configPath, config, principal, signal);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      cancel.abort();
      release();
      active.delete(cancel);
      void transport.close().catch(() => {});
      void server.close().catch(() => {});
    };
    res.once("close", cleanup);
    req.once("aborted", cleanup);
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch {
      if (!res.headersSent) respond(res, 500, "mcp_request_failed");
      else res.end();
      cleanup();
    } finally {
      release();
    }
  });
  http.headersTimeout = 15000;
  http.requestTimeout = 30000;
  http.maxHeadersCount = 32;
  http.on("clientError", (_err, socket) =>
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n")
  );
  const timer = setInterval(() => {
    void (async () => {
      const config = loadRemoteConfig(configPath);
      for (const work of pendingRemoteConclusions()) {
        if (shutdown.signal.aborted) break;
        const principal = config.clients.find((c) => c.id === work.principalId);
        if (
          !principal ||
          principal.tokenHash !== work.credentialId ||
          policyRevision(config, principal) !== work.policyRevision ||
          config.apiUrl.replace(/\/$/, "") !== work.endpoint.replace(/\/$/, "")
        )
          continue;
        try {
          await retryConclusions(
            createRemoteClient(configPath, config, principal, work.bank, shutdown.signal)
          );
        } catch {
          /* revoked and failed work remains bound, never redirected */
        }
      }
    })().catch(() => {});
  }, 30000);
  timer.unref();
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(startup.port, startup.bindHost, () => {
      http.removeListener("error", reject);
      resolve();
    });
  });
  return {
    http,
    async close() {
      shutdown.abort();
      clearInterval(timer);
      for (const cancel of active) cancel.abort();
      const forced = setTimeout(() => http.closeAllConnections(), 5000);
      forced.unref();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      clearTimeout(forced);
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const configPath = process.env.HINDSIGHT_REMOTE_CONFIG;
  if (!configPath) {
    console.error("HINDSIGHT_REMOTE_CONFIG is required");
    process.exitCode = 1;
  } else
    startRemoteServer(configPath)
      .then((running) => {
        console.log("Hindsight remote MCP listening");
        const stop = () => {
          void running.close().then(() => {
            process.exitCode = 0;
          });
        };
        process.once("SIGTERM", stop);
        process.once("SIGINT", stop);
      })
      .catch(() => {
        console.error("Hindsight remote MCP startup failed");
        process.exitCode = 1;
      });
}
