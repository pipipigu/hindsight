import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import { loadRemoteConfig } from "../remote/config";
import { within } from "./project-registry";

const text = z.string().trim().min(1).max(16000);
const chineseName = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/[\u3400-\u9fff]/);
const source = z.object({ path: text, sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const model = z
  .object({
    name: chineseName,
    source_query: text,
    scope: text,
    tags: z.array(z.string().min(1).max(256)).max(30).default([]),
    tags_match: z.enum(["any", "all", "any_strict", "all_strict", "exact"]).default("all"),
    fact_types: z
      .array(z.enum(["world", "experience", "observation"]))
      .min(1)
      .max(3),
    refresh: z.literal("manual").default("manual"),
    max_tokens: z.number().int().min(1).max(16000),
    source_refs: z.array(text).min(1).max(30),
  })
  .strict();
const schema = z
  .object({
    version: z.literal(1),
    project: z
      .object({ directory: text, bank_id: text, display_name: chineseName, purpose: text })
      .strict(),
    sources: z.array(source).max(100),
    models: z.array(model).max(20),
  })
  .strict();
export type ProjectModelPlan = z.infer<typeof schema>;
export type ModelPlanPageResult = {
  name: string;
  status: "created" | "skipped";
  page_id: string;
  mental_model_id: string;
  operation_id?: string;
  generation: "pending" | "not_requested";
};
export type ModelPlanApplyResult = {
  ok: boolean;
  code?: string;
  approved_sha256: string;
  pages: ModelPlanPageResult[];
};
export class ModelPlanError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function secretPath(path: string): boolean {
  return (
    path
      .split(/[\\/]/)
      .some((p) =>
        /^(\.git|\.env(?:\..*)?|\.ssh|\.hindsight|credentials?(?:\..*)?|secrets?(?:\..*)?)$/i.test(
          p
        )
      ) || /\.(pem|key|p12|pfx)$/i.test(path)
  );
}
function parsePlan(raw: string): ProjectModelPlan {
  let plan: ProjectModelPlan;
  try {
    plan = schema.parse(JSON.parse(raw));
  } catch {
    throw new ModelPlanError("model_plan_invalid");
  }
  if (
    plan.models.some(
      (m) =>
        !m.source_query.includes(m.scope) || !m.source_query.includes(plan.project.display_name)
    )
  )
    throw new ModelPlanError("model_plan_scope_missing");
  const paths = plan.sources.map((s) => s.path);
  if (
    !isAbsolute(plan.project.directory) ||
    (plan.models.length > 0 && plan.sources.length === 0) ||
    new Set(paths).size !== paths.length ||
    new Set(plan.models.map((m) => m.name)).size !== plan.models.length ||
    plan.models.some((m) => m.source_refs.some((p) => !paths.includes(p)))
  )
    throw new ModelPlanError("model_plan_invalid");
  for (const path of paths) {
    if (
      isAbsolute(path) ||
      !within(resolve(plan.project.directory, path), plan.project.directory) ||
      secretPath(path)
    )
      throw new ModelPlanError("model_plan_source_forbidden");
  }
  return plan;
}
export function inspectModelPlan(planFile: string): { plan: ProjectModelPlan; sha256: string } {
  const raw = readFileSync(planFile, "utf8");
  return { plan: parsePlan(raw), sha256: hash(raw) };
}
/** Run locally before SSH. Sources establish draft provenance; they are not imported as facts. */
export function verifyModelPlanSources(plan: ProjectModelPlan): void {
  plan = parsePlan(JSON.stringify(plan));
  try {
    const root = realpathSync(plan.project.directory);
    if (!statSync(root).isDirectory()) throw new Error();
    for (const s of plan.sources) {
      const file = realpathSync(resolve(root, s.path));
      if (
        !within(file, root) ||
        secretPath(relative(root, file)) ||
        !statSync(file).isFile() ||
        statSync(file).size > 1024 * 1024 ||
        hash(readFileSync(file)) !== s.sha256
      )
        throw new Error();
    }
  } catch {
    throw new ModelPlanError("model_plan_sources_changed");
  }
}
function sameSet(a: unknown, b: string[]): boolean {
  return Array.isArray(a) && JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
}
type TreeNode = {
  id: string;
  kind: "folder" | "page";
  name: string;
  mental_model_id?: string | null;
  children?: TreeNode[];
};
const nodeSchema: z.ZodType<TreeNode> = z.lazy(() =>
  z.object({
    id: text,
    kind: z.enum(["folder", "page"]),
    name: text,
    mental_model_id: z.string().nullable().optional(),
    children: z.array(nodeSchema).optional(),
  })
);
const treeSchema = z.object({ roots: z.array(nodeSchema) });
const banksSchema = z.object({
  banks: z.array(z.object({ bank_id: text, name: text })),
  total: z.number().optional(),
});
const pageSchema = z.object({
  name: text,
  description: z.string().nullable().optional(),
  tags: z.array(z.string()),
});
const mentalModelSchema = z.object({
  source_query: z.string().nullable(),
  tags: z.array(z.string()),
  max_tokens: z.number().nullable(),
  trigger: z
    .object({
      refresh_after_consolidation: z.boolean(),
      refresh_cron: z.string().nullable().optional(),
      fact_types: z.array(z.string()).nullable(),
      tags_match: z.string().nullable().optional(),
      tag_groups: z.array(z.unknown()).nullable().optional(),
    })
    .nullable(),
});
const createdSchema = z.object({
  page_id: text,
  mental_model_id: text,
  operation_id: z.string().nullable().optional(),
});
function parseResponse<T>(schema: z.ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new ModelPlanError("model_plan_invalid_response");
  return parsed.data;
}
/**
 * Approval hash locks the reviewed bytes; it does NOT prove human authorization.
 * The caller must first obtain the user's explicit approval of this exact draft.
 * scope is review-only: source_query must express the actual retrieval scope.
 * Remote application validates the bytes only; the caller validates local sources before SSH.
 */
export async function applyModelPlan(
  planText: string,
  approvedHash: string,
  serverConfigFile: string
): Promise<ModelPlanApplyResult> {
  const pages: ModelPlanPageResult[] = [];
  const result = (code?: string): ModelPlanApplyResult => ({
    ok: !code,
    ...(code ? { code } : {}),
    approved_sha256: hash(planText),
    pages,
  });
  if (!/^[a-f0-9]{64}$/.test(approvedHash) || hash(planText) !== approvedHash)
    return result("model_plan_approval_mismatch");
  let lock: number | undefined;
  const lockPath = `${serverConfigFile}.model-plan.lock`;
  try {
    const plan = parsePlan(planText);
    try {
      lock = openSync(lockPath, "wx", 0o600);
    } catch {
      return result("model_plan_apply_busy");
    }
    const configRaw = readFileSync(serverConfigFile, "utf8");
    const config = loadRemoteConfig(serverConfigFile);
    const bank = config.bankAliases?.[plan.project.bank_id] ?? plan.project.bank_id;
    if (!config.clients.some((c) => c.mode === "project" && c.bankId === bank && c.read && c.write))
      return result("model_plan_project_binding_missing");
    const bankList = config.apiUrl.replace(/\/$/, "") + "/v1/default/banks";
    const base = bankList + "/" + encodeURIComponent(bank);
    async function request(path: string, payload?: unknown, absolute = false): Promise<unknown> {
      if (readFileSync(serverConfigFile, "utf8") !== configRaw)
        throw new ModelPlanError("model_plan_configuration_changed");
      let response: Response;
      try {
        response = await fetch(absolute ? path : base + path, {
          method: payload === undefined ? "GET" : "POST",
          redirect: "error",
          headers: {
            ...(config.apiToken ? { Authorization: `Bearer ${config.apiToken}` } : {}),
            "Content-Type": "application/json",
          },
          ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
          signal: AbortSignal.timeout(15000),
        });
      } catch {
        throw new ModelPlanError(
          payload === undefined ? "model_plan_request_failed" : "creation_status_unknown"
        );
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new ModelPlanError(
          response.status === 404
            ? "model_plan_resource_missing"
            : payload === undefined
              ? "model_plan_request_failed"
              : "creation_status_unknown"
        );
      }
      try {
        const chunks: Uint8Array[] = [];
        let size = 0;
        const reader = response.body?.getReader();
        if (reader) {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.length;
            if (size > 1024 * 1024) {
              await reader.cancel();
              throw new ModelPlanError("model_plan_response_too_large");
            }
            chunks.push(part.value);
          }
        }
        return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      } catch (error) {
        if (error instanceof ModelPlanError && payload === undefined) throw error;
        throw new ModelPlanError(
          payload === undefined ? "model_plan_invalid_response" : "creation_status_unknown"
        );
      }
    }
    let found: { bank_id: string; name: string } | undefined;
    for (let offset = 0; offset < 10000; offset += 100) {
      const list = parseResponse(
        banksSchema,
        await request(`${bankList}?limit=100&offset=${offset}`, undefined, true)
      );
      found = list.banks.find((b) => b.bank_id === bank);
      if (
        found ||
        list.banks.length < 100 ||
        (list.total !== undefined && offset + 100 >= list.total)
      )
        break;
      if (offset === 9900) return result("model_plan_bank_listing_limit");
    }
    if (!found) return result("model_plan_resource_missing");
    if (found.name !== plan.project.display_name) return result("model_plan_project_name_mismatch");
    const tree = parseResponse(treeSchema, await request("/knowledge-base/tree"));
    const nodes: TreeNode[] = [];
    function flatten(list: TreeNode[]) {
      for (const n of list) {
        nodes.push(n);
        if (n.children) flatten(n.children);
      }
    }
    flatten(tree.roots);
    // Preflight EVERY existing name before any POST, avoiding partial writes on known conflicts.
    const existing = new Map<string, TreeNode & { mental_model_id: string }>();
    for (const m of plan.models) {
      const matches = nodes.filter((n) => n.name === m.name);
      if (matches.length > 1 || matches.some((n) => n.kind !== "page" || !n.mental_model_id))
        return result("model_plan_name_conflict");
      if (!matches.length) continue;
      const n = matches[0];
      if (!n.mental_model_id) return result("model_plan_name_conflict");
      const page = parseResponse(
        pageSchema,
        await request(`/knowledge-base/pages/${encodeURIComponent(n.id)}`)
      );
      const mm = parseResponse(
        mentalModelSchema,
        await request(`/mental-models/${encodeURIComponent(n.mental_model_id)}`)
      );
      const trigger = mm.trigger;
      if (
        page.name !== m.name ||
        page.description !== m.source_query ||
        mm.source_query !== m.source_query ||
        !sameSet(page.tags, m.tags) ||
        !sameSet(mm.tags, m.tags) ||
        mm.max_tokens !== m.max_tokens ||
        !trigger ||
        trigger.refresh_after_consolidation !== false ||
        trigger.refresh_cron != null ||
        !sameSet(trigger.fact_types, m.fact_types) ||
        trigger.tags_match !== m.tags_match ||
        (trigger.tag_groups != null && trigger.tag_groups.length > 0)
      )
        return result("model_plan_name_conflict");
      existing.set(m.name, { ...n, mental_model_id: n.mental_model_id });
    }
    for (const m of plan.models) {
      const n = existing.get(m.name);
      if (n) {
        pages.push({
          name: m.name,
          status: "skipped",
          page_id: n.id,
          mental_model_id: n.mental_model_id,
          generation: "not_requested",
        });
        continue;
      }
      const createdData = await request("/knowledge-base/pages", {
        name: m.name,
        source_query: m.source_query,
        tags: m.tags,
        max_tokens: m.max_tokens,
        trigger: {
          refresh_after_consolidation: false,
          refresh_cron: null,
          fact_types: m.fact_types,
          tags_match: m.tags_match,
          tag_groups: null,
        },
      });
      const parsedCreated = createdSchema.safeParse(createdData);
      if (!parsedCreated.success) return result("creation_status_unknown");
      const created = parsedCreated.data;
      pages.push({
        name: m.name,
        status: "created",
        page_id: created.page_id,
        mental_model_id: created.mental_model_id,
        ...(typeof created.operation_id === "string" ? { operation_id: created.operation_id } : {}),
        generation: "pending",
      });
    }
    return result();
  } catch (error) {
    return result(error instanceof ModelPlanError ? error.code : "model_plan_apply_failed");
  } finally {
    if (lock !== undefined) {
      closeSync(lock);
      unlinkSync(lockPath);
    }
  }
}
