/** Workspace-bound forwarding only. No REST client, capture, or local write queue. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CallToolResultSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { applyBankConfig, loadConfig, type Config } from "./config";
import { readRegistry, resolveRegisteredProject } from "./project-registry";
import type { PermissionMode } from "./tool-context";

const privateSchema = z
  .object({
    endpoint: z.string().url(),
    projects: z.record(
      z.string(),
      z.record(
        z.string(),
        z
          .object({
            readToken: z.string().min(32).max(4096),
            writeToken: z.string().min(32).max(4096).optional(),
          })
          .strict()
      )
    ),
  })
  .strict();
const writeNames = new Set(["hindsight_save_conclusion", "hindsight_ingest_document"]);
const readNames = new Set([
  "hindsight_list_banks",
  "hindsight_recall",
  "hindsight_search_observations",
  "hindsight_read_memory",
  "hindsight_search_knowledge_pages",
  "hindsight_list_knowledge_pages",
  "hindsight_read_knowledge_page",
  "hindsight_reflect",
  "hindsight_sync_status",
]);
const forbidden = new Set([
  "bank_id",
  "bankId",
  "bank",
  "cwd",
  "directory",
  "permission",
  "permission_mode",
  "mode",
  "endpoint",
  "apiUrl",
  "token",
  "apiToken",
  "_context",
  "harness",
]);
function privateConfig(cfg: Config) {
  try {
    if (!cfg.remoteMcpConfigFile) throw new Error();
    const stat = statSync(cfg.remoteMcpConfigFile);
    if (
      !stat.isFile() ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error();
    const raw = readFileSync(cfg.remoteMcpConfigFile, "utf8");
    const value = privateSchema.parse(JSON.parse(raw));
    const url = new URL(value.endpoint);
    if (
      url.pathname !== "/mcp" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== "https:" &&
        !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    )
      throw new Error();
    return { ...value, revision: createHash("sha256").update(raw).digest("hex") };
  } catch {
    throw new Error("remote_mcp_config_invalid");
  }
}
function binding(harness: string, cwd: string, write: boolean) {
  const cfg = loadConfig({ harness });
  if (cfg.disabled || cfg.bankResolution !== "registry") throw new Error("remote_project_disabled");
  const project = resolveRegisteredProject(cwd, cfg.projectRegistryFile);
  const resolved = applyBankConfig(cfg, project.bankId, cwd);
  if (resolved.cfg.disabled || resolved.bankId !== project.bankId)
    throw new Error("remote_project_binding_invalid");
  const remote = privateConfig(cfg);
  const credentials = remote.projects[harness]?.[project.bankId];
  const token = write ? credentials?.writeToken : credentials?.readToken;
  if (!token) throw new Error("remote_project_credential_missing");
  return {
    bankId: project.bankId,
    token,
    endpoint: remote.endpoint,
    identity: [
      cfg.remoteMcpConfigFile,
      cfg.projectRegistryFile,
      project.revision,
      remote.revision,
      project.bankId,
      token,
    ].join("\0"),
  };
}
async function connected<T>(
  initial: { bankId: string; token: string; endpoint: string },
  harness: string,
  verify: () => void,
  run: (client: Client, signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
  budget = 345000,
  catalogOnly = false
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("remote_mcp_cancelled"));
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => controller.abort(new Error("remote_mcp_timeout")), budget);
  const watcher = setInterval(() => {
    try {
      verify();
    } catch {
      controller.abort(new Error("remote_project_binding_changed"));
    }
  }, 500);
  const client = new Client({ name: "hindsight-workspace-bridge", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(initial.endpoint), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${initial.token}`,
        "X-Hindsight-Project-Bank": Buffer.from(initial.bankId).toString("base64url"),
        "X-Hindsight-Harness": harness,
        ...(catalogOnly ? { "X-Hindsight-Catalog": "1" } : {}),
      },
      signal: controller.signal,
    },
    fetch: (url, init) => fetch(url, { ...init, signal: controller.signal, redirect: "error" }),
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 1000,
      maxReconnectionDelay: 1000,
      reconnectionDelayGrowFactor: 1,
    },
  });
  try {
    verify();
    await client.connect(transport, { signal: controller.signal, timeout: budget });
    verify();
    if (controller.signal.aborted) throw controller.signal.reason;
    const result = await run(client, controller.signal);
    verify();
    if (controller.signal.aborted) throw controller.signal.reason;
    return result;
  } finally {
    clearTimeout(timer);
    clearInterval(watcher);
    signal?.removeEventListener("abort", abort);
    await client.close().catch(() => {});
  }
}
export async function fetchRemoteRules(
  harness: string,
  cwd: string,
  signal?: AbortSignal
): Promise<string | null> {
  let initial;
  try {
    initial = binding(harness, cwd, false);
  } catch (e) {
    if (
      e instanceof Error &&
      ["project_unregistered", "project_disabled", "project_directory_missing"].includes(e.message)
    )
      return null;
    throw e;
  }
  return connected(
    initial,
    harness,
    () => {
      if (binding(harness, cwd, false).identity !== initial.identity)
        throw new Error("remote_project_binding_changed");
    },
    async (client) => client.getInstructions() ?? "",
    signal,
    2500
  );
}
export async function fetchRemoteCatalog(
  harness: string,
  cfg: Config,
  signal?: AbortSignal
): Promise<{ instructions: string; tools: Tool[]; bankId: string }> {
  const remote = privateConfig(cfg);
  const project = readRegistry(cfg.projectRegistryFile).projects.find(
    (p) => p.enabled && remote.projects[harness]?.[p.bankId]
  );
  if (!project) throw new Error("remote_project_unregistered");
  // Discover with the write identity when available, but only initialize/listTools; never call tools.
  const write = Boolean(remote.projects[harness][project.bankId].writeToken);
  const initial = binding(harness, project.root, write);
  return connected(
    initial,
    harness,
    () => {
      if (binding(harness, project.root, write).identity !== initial.identity)
        throw new Error("remote_project_binding_changed");
    },
    async (client, currentSignal) => {
      const tools: Tool[] = [];
      let cursor: string | undefined;
      const cursors = new Set<string>();
      let pages = 0;
      do {
        if (++pages > 10 || (cursor && cursors.has(cursor)))
          throw new Error("remote_catalog_invalid");
        if (cursor) cursors.add(cursor);
        const page = await client.listTools(cursor ? { cursor } : {}, { signal: currentSignal });
        tools.push(...page.tools);
        cursor = page.nextCursor;
        if (tools.length > 100 || (tools.length === 0 && cursor))
          throw new Error("remote_catalog_invalid");
      } while (cursor);
      if (
        tools.some(
          (tool) =>
            (!readNames.has(tool.name) && !writeNames.has(tool.name)) ||
            tool.annotations?.readOnlyHint !== readNames.has(tool.name) ||
            Object.keys(tool.inputSchema.properties ?? {}).some((key) => forbidden.has(key))
        )
      )
        throw new Error("remote_catalog_invalid");
      return { instructions: client.getInstructions() ?? "", tools, bankId: initial.bankId };
    },
    signal,
    10000,
    true
  );
}
export async function callRemoteTool(
  harness: string,
  cwd: string,
  mode: PermissionMode,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal
): Promise<CallToolResult> {
  if (Object.keys(args).some((key) => forbidden.has(key)))
    throw new Error("remote_tool_context_override");
  const write = writeNames.has(name);
  if (!write && !readNames.has(name)) throw new Error("remote_tool_unavailable");
  if (write && mode !== "normal") throw new Error("remote_write_permission_denied");
  const initial = binding(harness, cwd, write);
  return connected(
    initial,
    harness,
    () => {
      if (binding(harness, cwd, write).identity !== initial.identity)
        throw new Error("remote_project_binding_changed");
    },
    (client, currentSignal) =>
      client
        .callTool({ name, arguments: args }, CallToolResultSchema, {
          signal: currentSignal,
          timeout: 345000,
        })
        .then((result) => CallToolResultSchema.parse(result)),
    signal
  );
}
