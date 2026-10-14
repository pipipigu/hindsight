import { projectErrorResult } from "../core/project-diagnostics";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DEFAULT_OBSERVATION_SCOPES, HindsightClient } from "../core/hindsight";
import { buildKnowledgeTools, type ToolResult } from "../core/knowledge-tools";
import { DEFAULT_REFLECT_TOOL_TIMEOUT_MS } from "../core/config";
import { MEMORY_SEARCH_GUIDE } from "../core/recall-guidance";
import { CONCLUSION_GUIDE } from "../core/conclusions";
import {
  loadRemoteConfig,
  permitsBank,
  policyRevision,
  type RemoteConfig,
  type RemotePrincipal,
} from "./config";

const readTools = new Set([
  "hindsight_recall",
  "hindsight_search_observations",
  "hindsight_read_memory",
  "hindsight_search_knowledge_pages",
  "hindsight_list_knowledge_pages",
  "hindsight_read_knowledge_page",
  "hindsight_reflect",
  "hindsight_sync_status",
]);
const instructions =
  MEMORY_SEARCH_GUIDE +
  "\n" +
  CONCLUSION_GUIDE +
  "\n自动对话采集、Git 导入及页面维护关闭；只按需主动查询和明确保存。";
const error = (message: string): ToolResult => ({
  isError: true,
  content: [{ type: "text", text: message }],
});

function assertLivePrincipal(
  path: string,
  initial: RemoteConfig,
  principal: RemotePrincipal
): RemotePrincipal {
  const current = loadRemoteConfig(path);
  const live = current.clients.find((client) => client.id === principal.id);
  if (!live || policyRevision(current, live) !== policyRevision(initial, principal))
    throw new Error("remote_authorization_changed");
  return live;
}
export function assertLiveGrant(
  path: string,
  initial: RemoteConfig,
  principal: RemotePrincipal,
  bankId: string,
  write = false
): void {
  const live = assertLivePrincipal(path, initial, principal);
  if (!live.read || (write && !live.write) || !permitsBank(live, bankId))
    throw new Error("remote_authorization_changed");
}

export function createRemoteClient(
  path: string,
  config: RemoteConfig,
  principal: RemotePrincipal,
  bankId: string,
  signal: AbortSignal
): HindsightClient {
  assertLiveGrant(path, config, principal, bankId);
  const client = new HindsightClient({
    apiUrl: config.apiUrl,
    apiToken: config.apiToken,
    bank: bankId,
    observationScopes: DEFAULT_OBSERVATION_SCOPES,
    dedupScopeId: config.dedupScopeId,
    remoteBinding: {
      principalId: principal.id,
      credentialId: principal.tokenHash,
      policyRevision: policyRevision(config, principal),
      assertRead: () => assertLiveGrant(path, config, principal, bankId),
      assertWrite: () => assertLiveGrant(path, config, principal, bankId, true),
    },
  });
  client.bindCancellation(signal);
  return client;
}

function publicBankId(config: RemoteConfig, bankId: string): string {
  return (
    Object.entries(config.bankAliases ?? {}).find(([, target]) => target === bankId)?.[0] ?? bankId
  );
}

async function bankDirectory(
  config: RemoteConfig,
  principal: RemotePrincipal,
  signal: AbortSignal
): Promise<{ bank_id: string; name?: string | null }[]> {
  if (!principal.read) throw new Error("remote_read_denied");
  const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
  const schema = z.object({
    banks: z
      .array(
        z.object({ bank_id: z.string().min(1).max(256), name: z.string().nullable().optional() })
      )
      .max(1000),
    total: z.number().int().min(0).optional(),
  });
  const rows: { bank_id: string; name?: string | null }[] = [];
  for (let offset = 0; offset < 1024; ) {
    const response = await fetch(
      `${config.apiUrl.replace(/\/$/, "")}/v1/default/banks?limit=100&offset=${offset}`,
      {
        headers: config.apiToken ? { Authorization: `Bearer ${config.apiToken}` } : {},
        signal: boundedSignal,
      }
    );
    if (!response.ok || !response.body) throw new Error("remote_bank_directory_unavailable");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 1024 * 1024) throw new Error("remote_directory_too_large");
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const page = schema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (page.total !== undefined && page.total > 1024)
      throw new Error("remote_directory_too_large");
    if (rows.length + page.banks.length > 1024) throw new Error("remote_directory_too_large");
    rows.push(...page.banks);
    offset += page.banks.length;
    if (page.total === undefined || offset >= page.total) break;
    if (!page.banks.length || offset >= 1024) throw new Error("remote_incomplete_directory");
  }
  const banks = [...new Map(rows.map((row) => [row.bank_id, row])).values()];
  if (
    Object.keys(config.bankAliases ?? {}).some((alias) =>
      banks.some((row) => row.bank_id === alias)
    )
  )
    throw new Error("remote_bank_alias_collision");
  return banks;
}

export async function listRemoteBanks(
  config: RemoteConfig,
  principal: RemotePrincipal,
  signal: AbortSignal
): Promise<{ bank_id: string; name?: string }[]> {
  return (await bankDirectory(config, principal, signal))
    .filter((row) => permitsBank(principal, row.bank_id))
    .map((row) => ({
      bank_id: publicBankId(config, row.bank_id),
      ...(row.name ? { name: row.name.slice(0, 200) } : {}),
    }))
    .sort((a, b) => a.bank_id.localeCompare(b.bank_id));
}

export function buildRemoteServer(
  path: string,
  config: RemoteConfig,
  principal: RemotePrincipal,
  signal: AbortSignal,
  catalogOnly = false
): McpServer {
  const extra = config.toolGuideExtra?.trim() ?? "";
  const scope = catalogOnly
    ? "本机工具目录仅用于发现工具；实际项目由可信宿主按每次会话工作区绑定，工具参数不接受库或目录覆盖。"
    : principal.mode === "project"
      ? `当前连接固定绑定项目记忆库 ${publicBankId(config, principal.bankId!)}；工具参数不接受库或目录覆盖。`
      : "当前连接可查询授权库；用 hindsight_list_banks 选择相关库，查询与保存均须明确 bank_id，勿默认遍历全部库。";
  const server = new McpServer(
    { name: "hindsight-remote", version: "0.9.0" },
    { instructions: [instructions, scope, extra].filter(Boolean).join("\n") }
  );
  if (!principal.read) return server;
  const sampleBank = principal.bankId ?? "remote-catalog-placeholder";
  // Catalog construction performs no I/O and never binds a library user to the placeholder.
  const sample = new HindsightClient({
    apiUrl: config.apiUrl,
    bank: sampleBank,
    remoteBinding: {
      principalId: principal.id,
      credentialId: principal.tokenHash,
      policyRevision: policyRevision(config, principal),
      assertRead: () => {
        throw new Error("catalog_only");
      },
      assertWrite: () => {
        throw new Error("catalog_only");
      },
    },
  });
  const options = {
    harness: principal.harness ?? "remote",
    reflectTimeoutMs: DEFAULT_REFLECT_TOOL_TIMEOUT_MS,
    toolGuideExtra: extra,
  };
  const tools = buildKnowledgeTools(sample, sampleBank, options).filter(
    (tool) =>
      readTools.has(tool.name) ||
      (principal.write && tool.name === "hindsight_save_conclusion") ||
      (principal.mode === "project" && principal.write && tool.name === "hindsight_ingest_document")
  );
  server.registerTool(
    "hindsight_list_banks",
    {
      description:
        "List authorized existing memory banks; choose a relevant bank before searching. Does not search all banks. " +
        extra,
      inputSchema: z
        .object({
          offset: z.number().int().min(0).default(0),
          limit: z.number().int().min(1).max(50).default(20),
        })
        .strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      try {
        const live = assertLivePrincipal(path, config, principal);
        if (!live.read) return error("remote_authorization_changed");
        const banks = await listRemoteBanks(config, principal, signal);
        assertLivePrincipal(path, config, principal);
        const end = Math.min(banks.length, args.offset + args.limit);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                banks: banks.slice(args.offset, end),
                total: banks.length,
                next_offset: end < banks.length ? end : null,
              }),
            },
          ],
        };
      } catch (e) {
        return error(
          e instanceof Error &&
            [
              "remote_bank_alias_collision",
              "remote_directory_too_large",
              "remote_incomplete_directory",
              "remote_authorization_changed",
            ].includes(e.message)
            ? e.message
            : "remote_bank_directory_unavailable"
        );
      }
    }
  );
  for (const tool of tools) {
    const shape = {
      ...tool.inputSchema,
      ...(principal.mode === "library"
        ? {
            bank_id: z
              .string()
              .trim()
              .min(1)
              .max(256)
              .describe(
                "Public bank_id returned by hindsight_list_banks; server resolves and authorizes the actual bank"
              ),
          }
        : {}),
    };
    server.registerTool(
      tool.name,
      {
        description: tool.description + " " + extra,
        inputSchema: z.object(shape).strict(),
        annotations: tool.annotations,
      },
      async (args, context) => {
        try {
          const { bank_id, ...clean } = args;
          const requested = principal.mode === "project" ? principal.bankId! : String(bank_id);
          // Project bindings and authorization lists are always canonical backend IDs.
          const bankId =
            principal.mode === "project"
              ? requested
              : config.bankAliases && Object.hasOwn(config.bankAliases, requested)
                ? config.bankAliases[requested]
                : requested;
          const scopedSignal = AbortSignal.any([signal, context.signal]);
          assertLiveGrant(path, config, principal, bankId, !tool.annotations.readOnlyHint);
          if (Object.keys(config.bankAliases ?? {}).length) {
            const directory = await bankDirectory(config, principal, scopedSignal);
            if (!directory.some((row) => row.bank_id === bankId))
              throw new Error("remote_bank_missing");
          }
          const visibleBankId = publicBankId(config, bankId);
          const client = createRemoteClient(path, config, principal, bankId, scopedSignal);
          const scoped = buildKnowledgeTools(client, bankId, options).find(
            (candidate) => candidate.name === tool.name
          )!;
          const result = await scoped.handler(clean, {
            permission: principal.write ? "normal" : "plan",
          });
          if (result.isError) return result;
          // Backend headers can arrive before a slow response body. Revalidate after the
          // complete operation, including write receipts, before releasing any successful data.
          assertLiveGrant(path, config, principal, bankId, !tool.annotations.readOnlyHint);
          return {
            ...result,
            content: result.content.map((block) => {
              let value: unknown;
              try {
                value = JSON.parse(block.text);
              } catch {
                value = block.text;
              }
              return {
                ...block,
                text: JSON.stringify(
                  value && typeof value === "object" && !Array.isArray(value)
                    ? {
                        ...value,
                        ...(tool.name === "hindsight_sync_status" ? { bank: visibleBankId } : {}),
                        bank_id: visibleBankId,
                      }
                    : { bank_id: visibleBankId, result: value }
                ),
              };
            }),
          };
        } catch (e) {
          return projectErrorResult(e, "remote_request_denied");
        }
      }
    );
  }
  return server;
}
