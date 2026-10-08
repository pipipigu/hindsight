#!/usr/bin/env node
import { pendingConclusionWorkspaces, retryConclusions } from "./core/conclusions";
import { z } from "zod";
import { cleanArguments, verifyToolContext } from "./core/tool-context";
/**
 * Native TS MCP (stdio) server exposing the `hindsight_*` knowledge-page + recall + capture tools.
 *
 * Bank resolution MUST mirror the hooks exactly (`resolveHostMemory`, i.e. loadConfig +
 * deriveBankId + the banks section, harness from the REQUIRED HINDSIGHT_MCP_HARNESS) so knowledge
 * pages, recall, and retain all land in ONE per-repo bank — this is
 * why this is a native TS server and not a reuse of the Python MCP (whose bank derivation
 * differs). MCP servers usually launch with the project dir as cwd; `HINDSIGHT_MCP_PROJECT_CWD`
 * is the survey's escape hatch when they do not. Cursor's Agents Window is the other case: it
 * spawns user-level `~/.cursor/mcp.json` from `~` and ignores stdio `cwd`. Cursor *does*
 * interpolate `${workspaceFolder}` in `args`, so the installer passes the open workspace as
 * argv[2] rather than as a Hindsight env setting.
 */
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { type Config } from "./core/config";
import { resolveHostMemory, resolveCatalogMemory, loadHostConfig } from "./core/host-client";
import { HindsightClient } from "./core/hindsight";
import { buildKnowledgeTools, type ToolSpec } from "./core/knowledge-tools";
import { buildPageTrigger } from "./core/missions";
import { buildRetainStamp } from "./core/retain-stamp";

/**
 * Which tools this server should expose for a given config. Pure + SDK-free so the
 * disabled-flag behavior is unit-testable without spinning up a real MCP host: a disabled
 * Hindsight (mirrors the hooks' `cfg.disabled` check) exposes NO tools — the server still
 * connects, it just has nothing registered.
 */
export function selectTools(
  cfg: Config,
  client: HindsightClient,
  bankId: string,
  opts: { cwd?: string; harness?: string; signal?: AbortSignal } = {}
): ToolSpec[] {
  const cwd = opts.cwd ?? process.cwd();
  const harness = opts.harness ?? cfg.harness;
  const tools = cfg.disabled
    ? []
    : buildKnowledgeTools(client, bankId, {
        repoDir: cwd,
        harness,
        pageTrigger: buildPageTrigger(cfg),
        reflectTimeoutMs: cfg.reflectToolTimeoutMs,
        reflectBudget: cfg.reflectBudget,
        toolGuideExtra: cfg.toolGuideExtra,
        stampFor: () => buildRetainStamp(cfg, { directory: cwd, harness, bankId }),
      });
  if (cfg.bankResolution !== "registry") return tools;
  return tools.map((tool) => ({
    ...tool,
    inputSchema: {
      ...tool.inputSchema,
      _context: z.string().optional().describe("Internal trusted hook context; do not generate"),
    },
    handler: async (args) => {
      try {
        const claims = verifyToolContext(args._context, tool.name, args);
        if (claims.harness !== harness) throw new Error("wrong_harness_context");
        const live = resolveHostMemory(harness, claims.cwd);
        if (opts.signal) live.client.bindCancellation(opts.signal);
        if (live.cfg.disabled) throw new Error("project_disabled");
        const bound = selectNativeTools(
          live.cfg,
          live.client,
          live.bankId,
          claims.cwd,
          harness
        ).find((t) => t.name === tool.name);
        if (!bound) throw new Error("tool_unavailable");
        return await bound.handler(cleanArguments(args), { permission: claims.mode });
      } catch {
        return {
          isError: true,
          content: [{ type: "text", text: "trusted_project_context_unavailable" }],
        };
      }
    },
  }));
}
function selectNativeTools(
  cfg: Config,
  client: HindsightClient,
  bankId: string,
  cwd: string,
  harness: string
): ToolSpec[] {
  return buildKnowledgeTools(client, bankId, {
    repoDir: cwd,
    harness,
    pageTrigger: buildPageTrigger(cfg),
    reflectTimeoutMs: cfg.reflectToolTimeoutMs,
    reflectBudget: cfg.reflectBudget,
  });
}

/**
 * The harness this server is running for, from the environment its registration declares.
 *
 * REQUIRED, deliberately with no fallback. This used to default to "claude-code", which read as a
 * safe convenience and was not: every host launches this same binary, so a registration that named
 * no harness was silently served as Claude Code — Codex ingests came back tagged
 * `harness:claude-code`, indistinguishable from Claude Code's own, and resolved Claude Code's bank
 * (#3603). A wrong answer here corrupts stored data; refusing to start is recoverable.
 */
export function resolveHarness(env: NodeJS.ProcessEnv = process.env): string {
  const harness = env.HINDSIGHT_MCP_HARNESS;
  if (!harness) {
    throw new Error(
      "HINDSIGHT_MCP_HARNESS is not set. Every coding agent launches this same mcp-server.js, so " +
        "only that variable identifies the caller — it decides the harness:<id> stamp on everything " +
        "ingested and which bank this session resolves. Re-run `npx " +
        "@vectorize-io/hindsight-coding-agents install <harness>` to repair a registration written " +
        "before the installer set it."
    );
  }
  return harness;
}

/**
 * Directory this process should treat as the project.
 *
 * Survey sets `HINDSIGHT_MCP_PROJECT_CWD`. Cursor cannot: user-level mcp.json is spawned from
 * `~` and Cursor does not interpolate `cwd`. The installer therefore passes
 * `${workspaceFolder}` as argv[2], which Cursor does interpolate.
 */
export function resolveProjectCwd(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
  fallbackCwd = process.cwd()
): string {
  const override = env.HINDSIGHT_MCP_PROJECT_CWD?.trim();
  if (override && !override.includes("${")) return override;
  if (env.HINDSIGHT_MCP_HARNESS === "cursor-cli") {
    const folder = argv[2]?.trim();
    if (folder && !folder.includes("${")) return folder;
  }
  return fallbackCwd;
}

/**
 * Build the MCP surface for the resolved project.
 *
 * An opted-out project intentionally has no Hindsight tools, but some clients probe `tools/list`
 * without first checking the initialize capabilities. Advertising an empty, queryable tool list
 * keeps that privacy boundary intact while preventing one optional probe from failing startup.
 */
export function buildMcpServer(tools: ToolSpec[]): McpServer {
  const server = new McpServer({ name: "hindsight", version: "0.1.0" });
  if (tools.length === 0) {
    server.server.registerCapabilities({ tools: { listChanged: false } });
    server.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
    return server;
  }

  for (const tool of tools) {
    // registerTool (not the deprecated `tool()`) so the safety annotations reach the client:
    // Dcode rejects unannotated MCP calls outright in headless mode, and Codex Auto-review treats
    // them as unverified external access. See ToolSpec.annotations.
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      },
      (args) => tool.handler(args)
    );
  }
  return server;
}

async function main() {
  const cwd = resolveProjectCwd();
  // Mirrors that harness's hooks: it selects the config `harnesses.<name>` section and feeds the
  // `{harness}` bank template, so both routes into a repo land in ONE bank.
  const harness = resolveHarness();
  const { cfg, bankId, client } = resolveHostMemory(harness, cwd);

  const shutdown = new AbortController();
  const global = loadHostConfig(harness);
  const catalogClient =
    cfg.bankResolution === "registry" ? resolveCatalogMemory(harness, cwd).client : client;
  const server = buildMcpServer(
    selectTools(
      { ...cfg, disabled: cfg.bankResolution === "registry" ? global.disabled : cfg.disabled },
      catalogClient,
      bankId,
      { cwd, harness, signal: shutdown.signal }
    )
  );

  const timer =
    global.bankResolution === "registry"
      ? setInterval(() => {
          void (async () => {
            for (const work of pendingConclusionWorkspaces()) {
              if (shutdown.signal.aborted) break;
              const live = resolveHostMemory(work.harness, work.cwd);
              live.client.bindCancellation(shutdown.signal);
              if (!live.cfg.disabled) await retryConclusions(live.client);
            }
          })().catch(() => {});
        }, 30000)
      : undefined;
  timer?.unref();
  server.server.onclose = () => {
    shutdown.abort();
    if (timer) clearInterval(timer);
  };
  await server.connect(new StdioServerTransport());
}

// Only auto-run when this file is executed directly (e.g. `node dist/mcp-server.js`) — importing
// it (as src/mcp-server.test.ts does) must not start a real server.
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error("hindsight mcp-server failed:", e);
    process.exit(1);
  });
}
