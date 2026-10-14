import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, request, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startRemoteServer } from "../mcp-http-server";
import { pendingRemoteConclusions } from "../core/conclusions";
import { credentialHash, loadRemoteConfig, policyRevision, type RemoteConfig } from "./config";

describe("remote HTTP MCP", () => {
  let root: string,
    config: RemoteConfig,
    path: string,
    backend: Server,
    running: Awaited<ReturnType<typeof startRemoteServer>>,
    origin: string;
  let clients: Client[],
    calls: { url: string; method: string; authorization: string | undefined; body: unknown }[];
  let slowStarted: () => void, slowClosed: () => void;
  let pagedDirectory: boolean;
  let directoryTotal: number, delayedReceipt: boolean, pendingReceipt: boolean;
  let heldResponses: ServerResponse[];
  const token = "library-user-credential-with-at-least-32-bytes";
  const projectToken = "project-user-credential-with-at-least-32-bytes";
  const writeToken = "write-user-credential-with-at-least-32-bytes";
  const backendToken = "backend-token-must-never-leak";
  const persist = () => writeFileSync(path, JSON.stringify(config));
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "hindsight-remote-http-"));
    path = join(root, "remote.json");
    process.env.HINDSIGHT_SHARED_STATE_DIR = join(root, "state");
    clients = [];
    calls = [];
    pagedDirectory = false;
    directoryTotal = 2;
    delayedReceipt = false;
    pendingReceipt = false;
    heldResponses = [];
    backend = createServer(async (req, res) => {
      const parts: Buffer[] = [];
      for await (const chunk of req) parts.push(Buffer.from(chunk));
      const body = parts.length ? JSON.parse(Buffer.concat(parts).toString()) : null;
      calls.push({
        url: req.url!,
        method: req.method!,
        authorization: req.headers.authorization,
        body,
      });
      res.setHeader("Content-Type", "application/json");
      const bank = decodeURIComponent(req.url?.match(/\/banks\/([^/]+)/)?.[1] ?? "");
      if (req.url?.startsWith("/v1/default/banks?") && pagedDirectory) {
        const offset = Number(new URL(req.url, "http://fixture").searchParams.get("offset"));
        res.end(
          JSON.stringify({
            banks: [
              { bank_id: offset === 0 ? "alpha" : "beta", name: offset === 0 ? "Alpha" : "Beta" },
            ],
            total: directoryTotal,
            offset,
            limit: 1,
          })
        );
      } else if (req.url?.startsWith("/v1/default/banks?"))
        res.end(
          JSON.stringify({
            banks: [
              { bank_id: "alpha", name: "Alpha", config: { secret: backendToken } },
              { bank_id: "beta", name: "Beta" },
              { bank_id: "hidden", name: "Hidden" },
              { bank_id: "项目中文", name: "中文项目" },
            ],
          })
        );
      else if (req.url?.endsWith("/stats")) {
        res.statusCode = bank === "missing" ? 404 : 200;
        res.end(JSON.stringify({ bank_id: bank }));
      } else if (req.url?.endsWith("/memories/recall") && body?.query === "held") {
        res.flushHeaders();
        heldResponses.push(res);
      } else if (
        req.url?.endsWith("/memories/recall") &&
        body?.query === "backend-credential-rotation"
      ) {
        res.flushHeaders();
        setTimeout(() => {
          config.apiToken = "rotated-backend-credential";
          persist();
        }, 50);
        setTimeout(
          () =>
            res.end(
              JSON.stringify({
                results: [
                  {
                    id: "ea277a76-e147-4943-92cf-d4b7bbbb7b8f",
                    text: "OLD_BACKEND_CREDENTIAL_DATA",
                    type: "world",
                  },
                ],
              })
            ),
          150
        );
      } else if (req.url?.endsWith("/memories/recall") && body?.query === "delayed-body") {
        res.flushHeaders();
        setTimeout(() => {
          config.clients[0].read = false;
          persist();
        }, 50);
        setTimeout(
          () =>
            res.end(
              JSON.stringify({
                results: [
                  {
                    id: "ea277a76-e147-4943-92cf-d4b7bbbb7b8f",
                    text: "REVOKED_BUT_EXPOSED",
                    type: "world",
                  },
                ],
              })
            ),
          150
        );
      } else if (req.url?.endsWith("/memories/recall") && body?.query === "slow") {
        res.once("close", () => slowClosed());
        slowStarted();
      } else if (req.url?.endsWith("/memories/recall"))
        res.end(
          JSON.stringify({
            results: [
              {
                id: "ea277a76-e147-4943-92cf-d4b7bbbb7b8f",
                text: `fact for ${bank}`,
                type: "world",
              },
            ],
          })
        );
      else if (req.url?.includes("/memories/ea277a76-e147-4943-92cf-d4b7bbbb7b8f"))
        res.end(
          JSON.stringify({
            id: "ea277a76-e147-4943-92cf-d4b7bbbb7b8f",
            bank_id: bank,
            text: "verified fact",
            chunk_id: "chunk-fixture",
          })
        );
      else if (req.url === "/v1/default/chunks/chunk-fixture")
        res.end(
          JSON.stringify({
            bank_id: "alpha",
            chunk_id: "chunk-fixture",
            chunk_text: "ORIGINAL_EVIDENCE_FROM_ALPHA",
            document_id: "document-fixture",
          })
        );
      else if (req.url === "/version") res.end(JSON.stringify({ api_version: "0.10.1" }));
      else if (req.url?.endsWith("/config"))
        res.end(
          JSON.stringify({
            config: {
              retain_strategies: {
                project_conclusions_v1: {
                  retain_extraction_mode: "concise",
                  retain_mission: "preserve evidence",
                },
              },
            },
          })
        );
      else if (req.method === "POST" && req.url?.endsWith("/memories"))
        res.end(JSON.stringify({ operation_id: body.operation_id }));
      else if (req.url?.includes("/operations/") && delayedReceipt) {
        res.flushHeaders();
        setTimeout(() => {
          config.clients[2].write = false;
          persist();
        }, 50);
        setTimeout(() => res.end(JSON.stringify({ status: "completed" })), 150);
      } else if (req.url?.includes("/operations/"))
        res.end(JSON.stringify({ status: pendingReceipt ? "processing" : "completed" }));
      else {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: backendToken }));
      }
    });
    await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
    const backendPort = (backend.address() as { port: number }).port;
    config = {
      apiUrl: `http://127.0.0.1:${backendPort}`,
      apiToken: backendToken,
      bindHost: "127.0.0.1",
      port: 0,
      maxConcurrentTools: 8,
      maxConcurrentToolsPerClient: 2,
      publicOrigin: "http://127.0.0.1",
      toolGuideExtra: "UNIFIED_CUSTOM_GUIDE",
      clients: [
        {
          id: "library",
          tokenHash: credentialHash(token),
          mode: "library",
          allowedBanks: ["alpha", "beta", "missing"],
          read: true,
          write: false,
        },
        {
          id: "project",
          tokenHash: credentialHash(projectToken),
          mode: "project",
          bankId: "beta",
          read: true,
          write: false,
        },
        {
          id: "writer",
          tokenHash: credentialHash(writeToken),
          mode: "library",
          allowedBanks: ["alpha", "beta", "missing"],
          read: true,
          write: true,
        },
      ],
    };
    persist();
    running = await startRemoteServer(path);
    origin = `http://127.0.0.1:${(running.http.address() as { port: number }).port}`;
    config.publicOrigin = origin;
    persist();
  });
  afterEach(async () => {
    await Promise.all(clients.map((client) => client.close().catch(() => {})));
    await running?.close();
    await new Promise<void>((resolve) => backend?.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
    delete process.env.HINDSIGHT_SHARED_STATE_DIR;
  });
  async function connect(credential = token, extraHeaders: Record<string, string> = {}) {
    const client = new Client({ name: "integration-test", version: "1" });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${credential}`, ...extraHeaders } },
      })
    );
    return client;
  }
  const text = (result: unknown) => JSON.stringify(result);
  it("requires canonical project and harness headers and rejects library credentials", async () => {
    config.clients[1].harness = "codex";
    config.clients[1].requireProjectBinding = true;
    persist();
    const headers = {
      "X-Hindsight-Project-Bank": Buffer.from("beta").toString("base64url"),
      "X-Hindsight-Harness": "codex",
    };
    for (const [credential, binding] of [
      [projectToken, {}],
      [
        projectToken,
        { ...headers, "X-Hindsight-Project-Bank": Buffer.from("alpha").toString("base64url") },
      ],
      [projectToken, { ...headers, "X-Hindsight-Harness": "dsh" }],
      [token, headers],
    ] as const) {
      const response = await fetch(`${origin}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${credential}`,
          ...binding,
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      expect(response.status).toBe(403);
    }
    expect(calls).toHaveLength(0);
    const client = await connect(projectToken, headers);
    const result = await client.callTool({
      name: "hindsight_recall",
      arguments: { query: "facts" },
    });
    expect(text(result)).toContain("fact for beta");
    const count = calls.length;
    config.clients[1].bankId = "alpha";
    persist();
    await expect(
      client.callTool({ name: "hindsight_recall", arguments: { query: "facts" } })
    ).rejects.toThrow();
    expect(calls).toHaveLength(count);
  });
  it("offers explicit document import only to writable project identities", async () => {
    const localToken = "local-project-write-credential-with-more-than-32-bytes";
    config.clients.push({
      id: "local-writer",
      tokenHash: credentialHash(localToken),
      mode: "project",
      bankId: "alpha",
      harness: "codex",
      requireProjectBinding: true,
      read: true,
      write: true,
    });
    persist();
    const client = await connect(localToken, {
      "X-Hindsight-Project-Bank": Buffer.from("alpha").toString("base64url"),
      "X-Hindsight-Harness": "codex",
    });
    expect(
      (await client.listTools()).tools.some((tool) => tool.name === "hindsight_ingest_document")
    ).toBe(true);
    const library = await connect(writeToken);
    expect(
      (await library.listTools()).tools.some((tool) => tool.name === "hindsight_ingest_document")
    ).toBe(false);
    const result = await client.callTool({
      name: "hindsight_ingest_document",
      arguments: { title: "Verified document", content: "Explicit verified source document" },
    });
    expect(result.isError).not.toBe(true);
    const retain = calls.find((call) => call.method === "POST" && call.url.endsWith("/memories"));
    expect(retain).toBeDefined();
    expect(JSON.stringify(retain?.body)).toContain("harness:codex");
  });
  it("keeps local catalog discovery generic and refuses all tool execution on that connection", async () => {
    config.clients[1].harness = "codex";
    config.clients[1].requireProjectBinding = true;
    persist();
    const headers = {
      "X-Hindsight-Project-Bank": Buffer.from("beta").toString("base64url"),
      "X-Hindsight-Harness": "codex",
      "X-Hindsight-Catalog": "1",
    };
    const client = await connect(projectToken, headers);
    expect(client.getInstructions()).toContain("实际项目由可信宿主按每次会话工作区绑定");
    expect(client.getInstructions()).not.toContain("固定绑定项目记忆库 beta");
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    await expect(
      client.callTool({ name: "hindsight_recall", arguments: { query: "facts" } })
    ).rejects.toThrow();
    const response = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${projectToken}`,
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "hindsight_reflect", arguments: { query: "facts" } },
      }),
    });
    expect(response.status).toBe(403);
    expect(calls).toHaveLength(0);
  });
  it("validates ASCII aliases and includes them in authorization revisions", () => {
    const revision = policyRevision(config, config.clients[0]);
    config.bankAliases = { "project-alpha": "alpha" };
    persist();
    expect(loadRemoteConfig(path).bankAliases).toEqual(config.bankAliases);
    expect(policyRevision(config, config.clients[0])).not.toBe(revision);
    const invalidAliases: Record<string, string>[] = [
      { 中文: "alpha" },
      { alpha: "alpha" },
      { one: "two", two: "alpha" },
      { one: "two", two: "one" },
      { one: "alpha", two: "alpha" },
    ];
    for (const aliases of invalidAliases) {
      config.bankAliases = aliases;
      persist();
      expect(() => loadRemoteConfig(path)).toThrow("invalid_remote_configuration");
    }
  });
  it("exposes aliases while reads, original evidence, saves and dedup use canonical banks", async () => {
    config.bankAliases = { "project-alpha": "alpha", "project-beta": "beta" };
    persist();
    const client = await connect(writeToken);
    const directory = await client.callTool({ name: "hindsight_list_banks", arguments: {} });
    const parsed = JSON.parse((directory.content as { text: string }[])[0].text);
    expect(parsed.banks).toEqual([
      { bank_id: "project-alpha", name: "Alpha" },
      { bank_id: "project-beta", name: "Beta" },
    ]);
    const recalled = await client.callTool({
      name: "hindsight_recall",
      arguments: { bank_id: "project-alpha", query: "facts" },
    });
    expect(text(recalled)).toContain("fact for alpha");
    expect(JSON.parse((recalled.content as { text: string }[])[0].text).bank_id).toBe(
      "project-alpha"
    );
    const original = await client.callTool({
      name: "hindsight_read_memory",
      arguments: {
        bank_id: "project-alpha",
        memory_id: "ea277a76-e147-4943-92cf-d4b7bbbb7b8f",
        section: "original",
      },
    });
    expect(text(original)).toContain("ORIGINAL_EVIDENCE_FROM_ALPHA");
    const args = { content: "alias durable conclusion", evidence: "verified alias test" };
    const saved = await client.callTool({
      name: "hindsight_save_conclusion",
      arguments: { ...args, bank_id: "project-alpha" },
    });
    expect(text(saved)).toContain("completed");
    await client.callTool({
      name: "hindsight_save_conclusion",
      arguments: { ...args, bank_id: "alpha" },
    });
    expect(
      calls.filter((call) => call.method === "POST" && call.url.endsWith("/memories"))
    ).toHaveLength(1);
    expect(
      calls
        .filter((call) => call.method === "POST")
        .every((call) => call.url.includes("/banks/alpha/"))
    ).toBe(true);
    const status = await client.callTool({
      name: "hindsight_sync_status",
      arguments: { bank_id: "project-alpha" },
    });
    expect(JSON.parse((status.content as { text: string }[])[0].text).bank).toBe("project-alpha");
    const project = await connect(projectToken);
    const result = await project.callTool({
      name: "hindsight_recall",
      arguments: { query: "facts" },
    });
    expect(JSON.parse((result.content as { text: string }[])[0].text).bank_id).toBe("project-beta");
    expect(
      (
        await project.callTool({
          name: "hindsight_recall",
          arguments: { bank_id: "project-alpha", query: "facts" },
        })
      ).isError
    ).toBe(true);
    const readonly = await connect();
    expect((await readonly.listTools()).tools.map((tool) => tool.name)).not.toContain(
      "hindsight_save_conclusion"
    );
  });
  it("returns English IDs and Chinese names for banks with Chinese canonical IDs", async () => {
    config.bankAliases = { "project-chinese": "项目中文" };
    config.clients[0].allowedBanks = ["项目中文"];
    persist();
    const client = await connect();
    const directory = await client.callTool({ name: "hindsight_list_banks", arguments: {} });
    expect(JSON.parse((directory.content as { text: string }[])[0].text).banks).toEqual([
      { bank_id: "project-chinese", name: "中文项目" },
    ]);
    const result = await client.callTool({
      name: "hindsight_recall",
      arguments: { bank_id: "project-chinese", query: "facts" },
    });
    expect(JSON.parse((result.content as { text: string }[])[0].text).bank_id).toBe(
      "project-chinese"
    );
    expect(text(result)).toContain("fact for 项目中文");
    expect(
      calls.some((call) =>
        call.url.includes(`/banks/${encodeURIComponent("项目中文")}/memories/recall`)
      )
    ).toBe(true);
  });
  it("stores pending alias saves under the actual bank and original policy", async () => {
    pendingReceipt = true;
    config.bankAliases = { "project-alpha": "alpha" };
    persist();
    const client = await connect(writeToken);
    const args = { content: "pending alias conclusion", evidence: "pending fixture" };
    const result = await client.callTool({
      name: "hindsight_save_conclusion",
      arguments: { ...args, bank_id: "project-alpha" },
    });
    expect(result.isError).not.toBe(true);
    const pending = pendingRemoteConclusions();
    expect(pending).toHaveLength(1);
    expect(pending[0].bank).toBe("alpha");
    expect(pending[0].policyRevision).toBe(
      policyRevision(loadRemoteConfig(path), config.clients[2])
    );
    await client.callTool({
      name: "hindsight_save_conclusion",
      arguments: { ...args, bank_id: "alpha" },
    });
    expect(
      calls.filter((call) => call.method === "POST" && call.url.endsWith("/memories"))
    ).toHaveLength(1);
    const originalRevision = pending[0].policyRevision;
    config.bankAliases = { "project-alpha": "beta" };
    persist();
    expect(pendingRemoteConclusions()[0]).toMatchObject({
      bank: "alpha",
      policyRevision: originalRevision,
    });
    expect(policyRevision(loadRemoteConfig(path), config.clients[2])).not.toBe(originalRevision);
  });
  it("rejects directory alias collisions on both listing and direct tool calls", async () => {
    config.bankAliases = { alpha: "hidden" };
    persist();
    const client = await connect();
    const directory = await client.callTool({ name: "hindsight_list_banks", arguments: {} });
    expect(text(directory)).toContain("remote_bank_alias_collision");
    for (const bank_id of ["alpha", "beta"]) {
      expect(
        (
          await client.callTool({
            name: "hindsight_recall",
            arguments: { bank_id, query: "facts" },
          })
        ).isError
      ).toBe(true);
    }
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });
  it("rejects an old canonical binding after aliases change", async () => {
    config.bankAliases = { "project-alpha": "alpha" };
    persist();
    const initial = loadRemoteConfig(path);
    const { createRemoteClient } = await import("./tools");
    const bound = createRemoteClient(
      path,
      initial,
      initial.clients[0],
      "alpha",
      new AbortController().signal
    );
    config.bankAliases = { "project-alpha": "beta" };
    persist();
    expect(() => bound.remoteBinding?.assertRead()).toThrow("remote_authorization_changed");
    expect(() => bound.remoteBinding?.assertWrite()).toThrow("remote_authorization_changed");
    expect(calls).toHaveLength(0);
  });
  it("requires bearer credentials and limits Host, Origin and body size", async () => {
    expect((await fetch(`${origin}/mcp`, { method: "POST", body: "{}" })).status).toBe(401);
    expect(
      (
        await fetch(`${origin}/mcp`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, Origin: "https://attacker.invalid" },
          body: "{}",
        })
      ).status
    ).toBe(403);
    const wrongHost = await new Promise<number | undefined>((resolve) => {
      const req = request(
        `${origin}/mcp`,
        { method: "POST", headers: { Authorization: `Bearer ${token}`, Host: "attacker.invalid" } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        }
      );
      req.end("{}");
    });
    expect(wrongHost).toBe(403);
    expect(
      (
        await fetch(`${origin}/mcp`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: "x".repeat(256 * 1024 + 1),
        })
      ).status
    ).toBe(413);
    expect((await fetch(`${origin}/health`)).status).toBe(200);
    expect(calls).toHaveLength(0);
  });
  it("publishes unified guidance, scoped directory and only curated tools", async () => {
    const client = await connect();
    expect(client.getInstructions()).toContain("UNIFIED_CUSTOM_GUIDE");
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).not.toContain("hindsight_ingest_document");
    expect(tools.tools.map((t) => t.name)).not.toContain("hindsight_save_conclusion");
    expect(tools.tools.every((t) => t.description?.includes("UNIFIED_CUSTOM_GUIDE"))).toBe(true);
    const directory = await client.callTool({
      name: "hindsight_list_banks",
      arguments: { limit: 1 },
    });
    expect(text(directory)).toContain("alpha");
    expect(text(directory)).not.toContain("hidden");
    expect(text(directory)).not.toContain(backendToken);
    const next = await client.callTool({
      name: "hindsight_list_banks",
      arguments: { offset: 1, limit: 1 },
    });
    expect(text(next)).toContain("beta");
  });
  it("isolates parallel library/project reads and rejects model binding overrides", async () => {
    const library = await connect(),
      project = await connect(projectToken);
    const [a, b] = await Promise.all([
      library.callTool({
        name: "hindsight_recall",
        arguments: { bank_id: "alpha", query: "facts" },
      }),
      project.callTool({ name: "hindsight_recall", arguments: { query: "facts" } }),
    ]);
    expect(text(a)).toContain("fact for alpha");
    expect(text(b)).toContain("fact for beta");
    const before = calls.length;
    for (const args of [
      { bank_id: "hidden", query: "facts" },
      { bank_id: "alpha", query: "facts", _context: "forged" },
      { query: "facts" },
    ]) {
      const result = await library.callTool({ name: "hindsight_recall", arguments: args });
      expect(result.isError).toBe(true);
    }
    expect(
      (
        await project.callTool({
          name: "hindsight_recall",
          arguments: { bank_id: "alpha", query: "facts" },
        })
      ).isError
    ).toBe(true);
    expect(calls).toHaveLength(before);
    expect(calls.every((call) => call.authorization === `Bearer ${backendToken}`)).toBe(true);
  });
  it("collects backend directory pages before reporting an authorized total", async () => {
    pagedDirectory = true;
    const client = await connect();
    const result = await client.callTool({ name: "hindsight_list_banks", arguments: {} });
    expect(text(result)).toContain("alpha");
    expect(text(result)).toContain("beta");
    expect(
      calls.filter((call) => call.url.startsWith("/v1/default/banks?")).map((call) => call.url)
    ).toEqual(["/v1/default/banks?limit=100&offset=0", "/v1/default/banks?limit=100&offset=1"]);
  });
  it("rejects oversized directories without pretending to return the full library", async () => {
    pagedDirectory = true;
    directoryTotal = 2000;
    const client = await connect();
    const result = await client.callTool({ name: "hindsight_list_banks", arguments: {} });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("remote_directory_too_large");
    expect(calls.filter((call) => call.url.startsWith("/v1/default/banks?"))).toHaveLength(1);
  });
  it("reports bank absence as a bank-stage error rather than a missing memory", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "hindsight_recall",
      arguments: { bank_id: "missing", query: "project facts" },
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse((result.content as { text: string }[])[0].text)).toMatchObject({
      code: "project_bank_missing",
      stage: "memory_bank",
    });
    expect(text(result)).not.toContain(backendToken);
    expect(calls.some((call) => call.url.endsWith("/memories/recall"))).toBe(false);
  });
  it("requires explicit authorized existing destination and evidence for saves", async () => {
    const client = await connect(writeToken);
    for (const args of [
      { content: "long term", evidence: "verified" },
      { bank_id: "alpha", content: "long term" },
      { bank_id: "hidden", content: "long term", evidence: "verified" },
    ])
      expect(
        (await client.callTool({ name: "hindsight_save_conclusion", arguments: args })).isError
      ).toBe(true);
    const missing = await client.callTool({
      name: "hindsight_save_conclusion",
      arguments: { bank_id: "missing", content: "long term", evidence: "verified" },
    });
    expect(text(missing)).not.toContain('"state":"completed"');
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
    const saved = await client.callTool({
      name: "hindsight_save_conclusion",
      arguments: {
        bank_id: "alpha",
        content: "verified durable decision",
        evidence: "fixture test evidence",
      },
    });
    expect(text(saved)).toContain("completed");
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });
  it("checks live authorization and redacts backend error payloads", async () => {
    const client = await connect();
    const failed = await client.callTool({
      name: "hindsight_reflect",
      arguments: { bank_id: "alpha", query: "fact" },
    });
    expect(failed.isError).toBe(true);
    expect(text(failed)).not.toContain(backendToken);
    config.clients[0].allowedBanks = ["beta"];
    persist();
    const before = calls.length;
    expect(
      (
        await client.callTool({
          name: "hindsight_recall",
          arguments: { bank_id: "alpha", query: "facts" },
        })
      ).isError
    ).toBe(true);
    expect(calls).toHaveLength(before);
    config.clients[0].tokenHash = credentialHash("rotated-user-credential-with-at-least-32-bytes");
    persist();
    expect(
      (
        await fetch(`${origin}/mcp`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: "{}",
        })
      ).status
    ).toBe(401);
  });
  it("reads scoped original evidence and rejects cross-bank chunk references", async () => {
    const client = await connect();
    const args = { memory_id: "ea277a76-e147-4943-92cf-d4b7bbbb7b8f", section: "original" };
    const alpha = await client.callTool({
      name: "hindsight_read_memory",
      arguments: { ...args, bank_id: "alpha" },
    });
    expect(text(alpha)).toContain("ORIGINAL_EVIDENCE_FROM_ALPHA");
    const beta = await client.callTool({
      name: "hindsight_read_memory",
      arguments: { ...args, bank_id: "beta" },
    });
    expect(beta.isError).toBe(true);
    expect(text(beta)).not.toContain("ORIGINAL_EVIDENCE_FROM_ALPHA");
  });
  it("does not release successful results after authorization is revoked during the response body", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "hindsight_recall",
      arguments: { bank_id: "alpha", query: "delayed-body" },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).not.toContain("REVOKED_BUT_EXPOSED");
  });
  it("does not release a successful write receipt after write authorization changes", async () => {
    delayedReceipt = true;
    const client = await connect(writeToken);
    const result = await client.callTool({
      name: "hindsight_save_conclusion",
      arguments: {
        bank_id: "alpha",
        content: "verified delayed receipt conclusion",
        evidence: "isolated test",
      },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).not.toContain("completed");
  });
  it("does not release old backend data when backend credentials rotate during a response", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "hindsight_recall",
      arguments: { bank_id: "alpha", query: "backend-credential-rotation" },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).not.toContain("OLD_BACKEND_CREDENTIAL_DATA");
    expect(text(result)).not.toContain("rotated-backend-credential");
    expect(text(result)).not.toContain(backendToken);
  });
  it("cancels upstream work when the HTTP caller disconnects", async () => {
    const started = new Promise<void>((resolve) => {
      slowStarted = resolve;
    });
    const closed = new Promise<void>((resolve) => {
      slowClosed = resolve;
    });
    const cancel = new AbortController();
    const pending = fetch(`${origin}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "hindsight_recall", arguments: { bank_id: "alpha", query: "slow" } },
      }),
      signal: cancel.signal,
    });
    await started;
    cancel.abort();
    await expect(pending).rejects.toThrow();
    await closed;
  });
  it("rejects JSON-RPC batches without calling the backend", async () => {
    const response = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(
        Array.from({ length: 16 }, (_, id) => ({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name: "hindsight_reflect", arguments: { bank_id: "alpha", query: "facts" } },
        }))
      ),
    });
    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
  it("limits per-principal and global active tools and releases completed or aborted slots", async () => {
    config.maxConcurrentTools = 3;
    persist();
    const args = (credential: string, query = "held", signal?: AbortSignal) => ({
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "hindsight_recall",
          arguments: credential === projectToken ? { query } : { bank_id: "alpha", query },
        },
      }),
      signal,
    });
    const waitHeld = async (count: number) => {
      for (let attempt = 0; attempt < 100 && heldResponses.length < count; attempt++)
        await new Promise((resolve) => setTimeout(resolve, 5));
      expect(heldResponses).toHaveLength(count);
    };
    const firstCancel = new AbortController(),
      secondCancel = new AbortController(),
      projectCancel = new AbortController();
    const first = fetch(`${origin}/mcp`, args(token, "held", firstCancel.signal));
    await waitHeld(1);
    const second = fetch(`${origin}/mcp`, args(token, "held", secondCancel.signal));
    await waitHeld(2);
    const principalRejected = await fetch(`${origin}/mcp`, args(token));
    expect(principalRejected.status).toBe(429);
    expect(principalRejected.headers.get("retry-after")).toBe("1");
    const project = fetch(`${origin}/mcp`, args(projectToken, "held", projectCancel.signal));
    await waitHeld(3);
    expect((await fetch(`${origin}/mcp`, args(writeToken))).status).toBe(429);
    // Tool listing remains usable while expensive tool slots are exhausted.
    expect(
      (
        await fetch(`${origin}/mcp`, {
          ...args(token),
          body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
        })
      ).status
    ).toBe(200);
    heldResponses[0].end(JSON.stringify({ results: [] }));
    expect((await first).status).toBe(200);
    expect((await fetch(`${origin}/mcp`, args(writeToken, "facts"))).status).toBe(200);
    secondCancel.abort();
    projectCancel.abort();
    await expect(second).rejects.toThrow();
    await expect(project).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await fetch(`${origin}/mcp`, args(token, "facts"))).status).toBe(200);
  });
  it("rejects ambiguous client mappings and invalid configuration without revealing tokens", () => {
    config.clients[0].bankId = "alpha";
    persist();
    expect(() => loadRemoteConfig(path)).toThrow("invalid_remote_configuration");
  });
});
