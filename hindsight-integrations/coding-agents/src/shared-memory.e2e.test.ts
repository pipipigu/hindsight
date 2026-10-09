import { afterEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let temp: string, server: Server | undefined, client: Client | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  }
  if (temp) rmSync(temp, { recursive: true, force: true });
});

it("runs the built Codex/Claude context hook and real MCP stdio from an unrelated cwd", async () => {
  temp = mkdtempSync("/tmp/hs-mcp-e2e-");
  const workspace = join(temp, "workspace");
  mkdirSync(workspace);
  const registry = join(temp, "projects.json"),
    config = join(temp, "config.json");
  writeFileSync(
    registry,
    JSON.stringify({ projects: [{ root: workspace, bankId: "p-fixture", enabled: true }] })
  );
  const requests: string[] = [];
  const recallRequests: Record<string, unknown>[] = [];
  server = createServer(async (req, res) => {
    requests.push(req.url!);
    res.setHeader("content-type", "application/json");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    if (req.url?.endsWith("/memories/recall")) {
      recallRequests.push(body);
      res.end(
        JSON.stringify({
          results: [
            {
              id: "11111111-1111-4111-8111-111111111111",
              type: body.types[0],
              text: "Fixture memory evidence",
              source_fact_ids: body.include?.source_facts ? ["s"] : [],
              chunk_id: body.include?.chunks ? "c" : null,
            },
          ],
          chunks: body.include?.chunks
            ? { c: { chunk_text: "Fixture original paragraph" } }
            : undefined,
          source_facts: body.include?.source_facts
            ? { s: { id: "s", text: "Fixture source fact" } }
            : undefined,
        })
      );
      return;
    }
    if (req.url?.endsWith("/memories/11111111-1111-4111-8111-111111111111")) {
      res.end(
        JSON.stringify({
          id: "11111111-1111-4111-8111-111111111111",
          type: "world",
          text: "Fixture addressed evidence",
          state: "valid",
          chunk_id: "p-fixture-owned-chunk",
        })
      );
      return;
    }
    if (req.url === "/v1/default/chunks/p-fixture-owned-chunk") {
      res.end(
        JSON.stringify({
          bank_id: "p-fixture",
          chunk_id: "p-fixture-owned-chunk",
          chunk_text: "Fixture addressed original",
        })
      );
      return;
    }
    const value = req.url?.endsWith("/stats")
      ? { bank_id: "p-fixture" }
      : req.url === "/version"
        ? { api_version: "0.10.1" }
        : req.url?.endsWith("/config")
          ? {
              config: {
                retain_strategies: {
                  project_conclusions_v1: {
                    retain_extraction_mode: "concise",
                    retain_mission: "Fixture durable conclusions",
                  },
                },
              },
            }
          : req.url?.endsWith("/memories")
            ? { operation_id: body.operation_id }
            : req.url?.includes("/operations/")
              ? { status: "completed" }
              : { roots: [{ id: "page", kind: "page", name: "Conventions and patterns" }] };
    res.end(JSON.stringify(value));
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  const address = server.address() as { port: number };
  writeFileSync(
    config,
    JSON.stringify({
      bankResolution: "registry",
      projectRegistryFile: registry,
      serverMode: "self-hosted",
      apiUrl: `http://127.0.0.1:${address.port}`,
    })
  );
  for (const harness of ["codex", "claude-code"]) {
    const env = Object.fromEntries(
      Object.entries({
        ...process.env,
        HINDSIGHT_CONFIG: config,
        HINDSIGHT_SHARED_STATE_DIR: join(temp, "state"),
        HINDSIGHT_CONTEXT_KEY_FILE: join(temp, "context.key"),
        HINDSIGHT_MCP_HARNESS: harness,
      }).filter((pair): pair is [string, string] => typeof pair[1] === "string")
    );
    client = new Client({ name: "isolated-fixture", version: "1" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [resolve("dist/mcp-server.js")],
        cwd: temp,
        env,
        stderr: "pipe",
      })
    );
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("hindsight_save_conclusion");
    expect(tools.tools.map((t) => t.name)).toContain("hindsight_search_observations");
    expect(tools.tools.map((t) => t.name)).toContain("hindsight_recall");
    for (const toolName of ["hindsight_recall", "hindsight_search_observations"]) {
      const query = {
        output_format: toolName === "hindsight_recall" ? "raw" : "compact",
        query: "fixture evidence",
        max_tokens: 4096,
        budget: "mid",
        limit: 5,
        output_tokens: 2000,
        seen_ids: [],
        include: {
          chunks: { max_tokens: 1000 },
          source_facts: { max_tokens: 2000 },
          entities: null,
        },
      };
      expect((await client.callTool({ name: toolName, arguments: query })).isError).toBe(true);
      const queryHook = spawnSync(
        process.execPath,
        [resolve("dist/shared-context-hook.js"), harness],
        {
          env,
          input: JSON.stringify({
            hook_event_name: "PreToolUse",
            tool_name: `mcp__hindsight__${toolName}`,
            tool_input: query,
            cwd: workspace,
            session_id: "fixture",
            permission_mode: "plan",
          }),
          encoding: "utf8",
        }
      );
      expect(queryHook.status).toBe(0);
      const queryResult = await client.callTool({
        name: toolName,
        arguments: JSON.parse(queryHook.stdout).hookSpecificOutput.updatedInput,
      });
      expect(queryResult.isError, JSON.stringify(queryResult)).not.toBe(true);
      expect(JSON.stringify(queryResult.content)).toContain("Fixture memory evidence");
      expect(JSON.stringify(queryResult.content)).toContain("Fixture source fact");
      const data = JSON.parse((queryResult.content as { type: string; text: string }[])[0].text);
      if (query.output_format === "raw")
        expect(data.source_facts.s.text).toBe("Fixture source fact");
      else expect(data.sources.F1.text).toBe("Fixture source fact");
    }
    for (const section of ["fact", "original"]) {
      const readName = "hindsight_read_memory";
      const args = { memory_id: "11111111-1111-4111-8111-111111111111", section };
      expect((await client.callTool({ name: readName, arguments: args })).isError).toBe(true);
      const readHook = spawnSync(
        process.execPath,
        [resolve("dist/shared-context-hook.js"), harness],
        {
          env,
          input: JSON.stringify({
            hook_event_name: "PreToolUse",
            tool_name: `mcp__hindsight__${readName}`,
            tool_input: args,
            cwd: workspace,
            session_id: "fixture",
            permission_mode: "plan",
          }),
          encoding: "utf8",
        }
      );
      expect(readHook.status).toBe(0);
      const read = await client.callTool({
        name: readName,
        arguments: JSON.parse(readHook.stdout).hookSpecificOutput.updatedInput,
      });
      expect(read.isError, JSON.stringify(read)).not.toBe(true);
      expect(JSON.stringify(read.content)).toContain(
        section === "fact" ? "Fixture addressed evidence" : "Fixture addressed original"
      );
    }
    const name = "hindsight_list_knowledge_pages";
    expect((await client.callTool({ name, arguments: {} })).isError).toBe(true);
    const hook = spawnSync(process.execPath, [resolve("dist/shared-context-hook.js"), harness], {
      env,
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: `mcp__hindsight__${name}`,
        tool_input: {},
        cwd: workspace,
        session_id: "fixture",
        permission_mode: "plan",
      }),
      encoding: "utf8",
    });
    expect(hook.status).toBe(0);
    const args = JSON.parse(hook.stdout).hookSpecificOutput.updatedInput;
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(JSON.stringify(result.content)).toContain("Conventions and patterns");
    const writeName = "hindsight_save_conclusion",
      write = { content: "Fixture durable rule", evidence: "Fixture human decision" };
    const planHook = spawnSync(
      process.execPath,
      [resolve("dist/shared-context-hook.js"), harness],
      {
        env,
        input: JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: `mcp__hindsight__${writeName}`,
          tool_input: write,
          cwd: workspace,
          session_id: "fixture",
          permission_mode: "plan",
        }),
        encoding: "utf8",
      }
    );
    const blocked = await client.callTool({
      name: writeName,
      arguments: JSON.parse(planHook.stdout).hookSpecificOutput.updatedInput,
    });
    expect(blocked.isError).toBe(true);
    expect(JSON.stringify(blocked.content)).toContain("plan_readonly");
    const normalInput = {
      content: "  Fixture durable rule  ",
      evidence: "  Fixture human decision  ",
    };
    const normalHook = spawnSync(
      process.execPath,
      [resolve("dist/shared-context-hook.js"), harness],
      {
        env,
        input: JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: `mcp__hindsight__${writeName}`,
          tool_input: normalInput,
          cwd: workspace,
          session_id: "fixture",
          permission_mode: "default",
        }),
        encoding: "utf8",
      }
    );
    const saved = await client.callTool({
      name: writeName,
      arguments: JSON.parse(normalHook.stdout).hookSpecificOutput.updatedInput,
    });
    expect(saved.isError, JSON.stringify(saved)).not.toBe(true);
    expect(JSON.stringify(saved.content)).toContain("completed");
    await client.close();
    client = undefined;
  }
  expect(
    requests.every(
      (path) =>
        path === "/version" ||
        path.includes("/p-fixture/") ||
        path === "/v1/default/chunks/p-fixture-owned-chunk"
    )
  ).toBe(true);
  expect(recallRequests.map((r) => r.types)).toEqual([
    ["world", "experience"],
    ["observation"],
    ["world", "experience"],
    ["observation"],
  ]);
  expect(
    recallRequests.every(
      (r) => !["output_format", "limit", "output_tokens", "seen_ids"].some((key) => key in r)
    )
  ).toBe(true);
}, 15000);
