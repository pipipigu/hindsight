import { afterEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server as HttpServer } from "node:http";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

let temp: string | undefined, http: HttpServer | undefined;
const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  if (http) {
    http.closeAllConnections();
    await new Promise<void>((done) => http!.close(() => done()));
    http = undefined;
  }
  if (temp) rmSync(temp, { recursive: true, force: true });
});

it("enforces process-scoped read-only memory over real signed stdio and HTTP MCP", async () => {
  temp = mkdtempSync("/tmp/hs-subagent-e2e-");
  const workspace = join(temp, "workspace");
  mkdirSync(workspace);
  const registry = join(temp, "projects.json"),
    config = join(temp, "config.json"),
    secrets = join(temp, "private.json");
  const readToken = "fixture-read-identity-32-characters-long";
  const writeToken = "fixture-write-identity-32-characters-long";
  const calls: { token: string; name: string }[] = [];
  const requests: { token: string; method: string }[] = [];
  const tools = [
    "hindsight_recall",
    "hindsight_sync_status",
    "hindsight_save_conclusion",
    "hindsight_ingest_document",
  ].map((name, index) => ({
    name,
    description: name,
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string" },
        content: { type: "string" },
        evidence: { type: "string" },
      },
    },
    annotations: { readOnlyHint: index < 2 },
  }));
  http = createServer(async (req, res) => {
    const token = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
    if (![readToken, writeToken].includes(token)) {
      res.writeHead(401).end();
      return;
    }
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(Buffer.from(part));
    const body = parts.length ? JSON.parse(Buffer.concat(parts).toString()) : undefined;
    requests.push({ token, method: body?.method ?? req.method ?? "" });
    const nas = new Server(
      { name: "isolated-fake-nas", version: "1" },
      {
        capabilities: { tools: {} },
        instructions: "Fixture project memory",
      }
    );
    nas.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: token === readToken ? tools.slice(0, 2) : tools,
    }));
    nas.setRequestHandler(CallToolRequestSchema, async (request) => {
      const name = request.params.name;
      calls.push({ token, name });
      if (
        token === readToken &&
        ["hindsight_save_conclusion", "hindsight_ingest_document"].includes(name)
      )
        return { isError: true, content: [{ type: "text", text: "read_identity_denied" }] };
      return {
        content: [
          {
            type: "text",
            text: name === "hindsight_save_conclusion" ? "fixture-saved" : "fixture-read",
          },
        ],
      };
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void nas.close();
    });
    await nas.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  await new Promise<void>((done, reject) => {
    http!.once("error", reject);
    http!.listen(0, "127.0.0.1", done);
  });
  const port = (http.address() as { port: number }).port;
  writeFileSync(
    registry,
    JSON.stringify({ projects: [{ root: workspace, bankId: "p-fixture", enabled: true }] })
  );
  writeFileSync(
    secrets,
    JSON.stringify({
      endpoint: `http://127.0.0.1:${port}/mcp`,
      projects: { codex: { "p-fixture": { readToken, writeToken } } },
    }),
    { mode: 0o600 }
  );
  writeFileSync(
    config,
    JSON.stringify({
      bankResolution: "registry",
      projectRegistryFile: registry,
      remoteMcpConfigFile: secrets,
    })
  );
  const baseEnv = Object.fromEntries(
    Object.entries({
      ...Object.fromEntries(
        Object.entries(process.env).filter(([name]) => !name.startsWith("HINDSIGHT_"))
      ),
      HINDSIGHT_CONFIG: config,
      HINDSIGHT_BANK_RESOLUTION: "registry",
      HINDSIGHT_CONTEXT_KEY_FILE: join(temp, "context.key"),
      HINDSIGHT_SHARED_STATE_DIR: join(temp, "state"),
      HINDSIGHT_MCP_HARNESS: "codex",
    }).filter((pair): pair is [string, string] => typeof pair[1] === "string")
  );
  async function connect(access: string) {
    const client = new Client({ name: "isolated-probe", version: "1" });
    clients.push(client);
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [resolve("dist/mcp-server.js")],
        cwd: temp,
        env: { ...baseEnv, HINDSIGHT_MEMORY_ACCESS: access },
        stderr: "pipe",
      })
    );
    return client;
  }
  function signed(name: string, args: Record<string, unknown>) {
    const hook = spawnSync(process.execPath, [resolve("dist/shared-context-hook.js"), "codex"], {
      env: { ...baseEnv, HINDSIGHT_MEMORY_ACCESS: "read-only" },
      encoding: "utf8",
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: `mcp__hindsight__${name}`,
        tool_input: args,
        cwd: workspace,
        session_id: "fixture-subagent",
        permission_mode: "normal",
      }),
    });
    expect(hook.status, hook.stderr).toBe(0);
    const output = JSON.parse(hook.stdout).hookSpecificOutput;
    expect(output.permissionDecision).toBe("allow");
    return output.updatedInput;
  }
  const child = await connect("read-only");
  const catalog = await child.listTools();
  expect(catalog.tools.map((tool) => tool.name)).toEqual([
    "hindsight_recall",
    "hindsight_sync_status",
  ]);
  expect(catalog.tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
  expect(requests.every((request) => request.token === readToken)).toBe(true);
  for (const name of ["hindsight_recall", "hindsight_sync_status"]) {
    const result = await child.callTool({
      name,
      arguments: signed(name, name === "hindsight_recall" ? { query: "fixture" } : {}),
    });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(JSON.stringify(result.content)).toContain("fixture-read");
  }
  const countBeforeWrites = requests.length;
  for (const name of ["hindsight_save_conclusion", "hindsight_ingest_document"]) {
    const result = await child.callTool({
      name,
      arguments: signed(name, { content: "fixture fact", evidence: "fixture source" }),
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("memory_readonly");
  }
  expect(requests).toHaveLength(countBeforeWrites);
  expect(calls).toEqual([
    { token: readToken, name: "hindsight_recall" },
    { token: readToken, name: "hindsight_sync_status" },
  ]);
  // The same config still grants normal standalone processes their own writable authority.
  const main = await connect("read-write");
  expect((await main.listTools()).tools.map((tool) => tool.name)).toContain(
    "hindsight_save_conclusion"
  );
  const saved = await main.callTool({
    name: "hindsight_save_conclusion",
    arguments: signed("hindsight_save_conclusion", {
      content: "fixture fact",
      evidence: "fixture source",
    }),
  });
  expect(saved.isError, JSON.stringify(saved)).not.toBe(true);
  expect(JSON.stringify(saved.content)).toContain("fixture-saved");
  expect(calls.at(-1)).toEqual({ token: writeToken, name: "hindsight_save_conclusion" });
}, 30000);
