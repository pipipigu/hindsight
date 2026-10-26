import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyModelPlan, inspectModelPlan, verifyModelPlanSources } from "./project-model-plan";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
let root: string, config: string;
let plan: any;
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
let posts: unknown[];
let fetchMock: ReturnType<typeof vi.fn<(url: string, init: RequestInit) => Promise<Response>>>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "model-plan-"));
  writeFileSync(join(root, "README.md"), "项目内容");
  config = join(root, "remote.json");
  writeFileSync(
    config,
    JSON.stringify({
      apiUrl: "http://stub.invalid",
      publicOrigin: "http://stub.invalid",
      clients: [
        {
          id: "test",
          tokenHash: "a".repeat(64),
          mode: "project",
          bankId: "p-test",
          read: true,
          write: true,
        },
      ],
    })
  );
  plan = {
    version: 1,
    project: {
      directory: root,
      bank_id: "p-test",
      display_name: "测试项目",
      purpose: "测试目录内容",
    },
    sources: [{ path: "README.md", sha256: hash("项目内容") }],
    models: [
      {
        name: "项目结构",
        source_query: "测试项目的项目模块结构是什么？",
        scope: "项目模块结构",
        tags: [],
        fact_types: ["world", "experience"],
        refresh: "manual",
        max_tokens: 1000,
        source_refs: ["README.md"],
      },
    ],
  };
  posts = [];
  fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    if (init.method === "POST") {
      posts.push(JSON.parse(init.body as string));
      return response({ page_id: "page-1", mental_model_id: "model-1", operation_id: "op-1" }, 201);
    }
    return response(
      url.includes("/banks?limit=")
        ? { banks: [{ bank_id: "p-test", name: "测试项目" }] }
        : { roots: [] }
    );
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});
const apply = () => {
  const raw = JSON.stringify(plan);
  return applyModelPlan(raw, hash(raw), config);
};
describe("approved project model plans", () => {
  it("rejects absent approval and changed bytes before any IO/network", async () => {
    const raw = JSON.stringify(plan);
    expect((await applyModelPlan(raw, "", config)).code).toBe("model_plan_approval_mismatch");
    expect((await applyModelPlan(raw + " ", hash(raw), config)).code).toBe(
      "model_plan_approval_mismatch"
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("inspects exact bytes and verifies local evidence", () => {
    const raw = JSON.stringify(plan);
    const file = join(root, "plan.json");
    writeFileSync(file, raw);
    expect(inspectModelPlan(file).sha256).toBe(hash(raw));
    verifyModelPlanSources(inspectModelPlan(file).plan);
    writeFileSync(join(root, "README.md"), "changed");
    expect(() => verifyModelPlanSources(plan)).toThrow("model_plan_sources_changed");
  });
  it.each(["../outside", ".env", ".ssh/id_rsa", "/absolute"])("forbids source %s", async (path) => {
    plan.sources[0].path = path;
    plan.models[0].source_refs = [path];
    expect((await apply()).code).toBe("model_plan_source_forbidden");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("requires Chinese project and model names", async () => {
    plan.project.display_name = "test";
    expect((await apply()).code).toBe("model_plan_invalid");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("rejects duplicate names before requests", async () => {
    plan.models.push(plan.models[0]);
    expect((await apply()).code).toBe("model_plan_invalid");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("creates only approved page definitions and reports pending generation", async () => {
    const result = await apply();
    expect(result.ok).toBe(true);
    expect(result.pages[0]).toMatchObject({ generation: "pending", operation_id: "op-1" });
    expect(posts).toEqual([
      {
        name: "项目结构",
        source_query: "测试项目的项目模块结构是什么？",
        tags: [],
        max_tokens: 1000,
        trigger: {
          refresh_after_consolidation: false,
          refresh_cron: null,
          tags_match: "all",
          tag_groups: null,
          fact_types: ["world", "experience"],
        },
      },
    ]);
    expect(readFileSync(config, "utf8")).toContain("p-test");
  });
  it("permits an approved empty plan without seeding pages", async () => {
    plan.models = [];
    plan.sources = [];
    expect((await apply()).ok).toBe(true);
    expect(posts).toHaveLength(0);
  });
  function existing(query = plan.models[0].source_query) {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/banks?limit="))
        return response({ banks: [{ bank_id: "p-test", name: "测试项目" }] });
      if (url.endsWith("/tree"))
        return response({
          roots: [{ id: "page-1", kind: "page", name: "项目结构", mental_model_id: "model-1" }],
        });
      if (url.includes("/pages/"))
        return response({ name: "项目结构", description: query, tags: [] });
      return response({
        source_query: query,
        tags: [],
        max_tokens: 1000,
        trigger: {
          refresh_after_consolidation: false,
          refresh_cron: null,
          tags_match: "all",
          tag_groups: null,
          fact_types: ["world", "experience"],
        },
      });
    });
  }
  it("skips exact existing definitions", async () => {
    existing();
    expect((await apply()).pages[0].status).toBe("skipped");
    expect(posts).toHaveLength(0);
  });
  it("rejects an existing conflicting query", async () => {
    existing("different");
    expect((await apply()).code).toBe("model_plan_name_conflict");
    expect(posts).toHaveLength(0);
  });
  it("never retries ambiguous POST failures", async () => {
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (init.method === "POST") throw new Error("SECRET timeout");
      return original(url, init);
    });
    const result = await apply();
    expect(result.code).toBe("creation_status_unknown");
    expect(fetchMock.mock.calls.filter((c) => c[1].method === "POST")).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });
  it("rejects mismatched bank name", async () => {
    plan.project.display_name = "其他项目";
    plan.models[0].source_query = "其他项目的项目模块结构是什么？";
    expect((await apply()).code).toBe("model_plan_project_name_mismatch");
    expect(posts).toHaveLength(0);
  });
  it("detects config mutation before POST", async () => {
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      const value = await original(url, init);
      if (url.endsWith("/tree")) writeFileSync(config, "{}");
      return value;
    });
    expect((await apply()).code).toBe("model_plan_configuration_changed");
    expect(posts).toHaveLength(0);
  });
  it("rejects secret symlink targets during local verification", () => {
    writeFileSync(join(root, ".env"), "private");
    symlinkSync(join(root, ".env"), join(root, "notes.md"));
    plan.sources = [{ path: "notes.md", sha256: hash("private") }];
    plan.models[0].source_refs = ["notes.md"];
    expect(() => verifyModelPlanSources(plan)).toThrow("model_plan_sources_changed");
  });
  it("preserves created page receipts when a later POST fails", async () => {
    plan.models.push({ ...plan.models[0], name: "部署流程" });
    const original = fetchMock.getMockImplementation()!;
    let count = 0;
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (init.method === "POST" && ++count === 2) throw new Error("timeout");
      return original(url, init);
    });
    const result = await apply();
    expect(result.code).toBe("creation_status_unknown");
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0].page_id).toBe("page-1");
    expect(count).toBe(2);
    expect(fetchMock.mock.calls.some((c) => c[1].method === "DELETE")).toBe(false);
  });
  it("does not contact API without a configured project write binding", async () => {
    plan.project.bank_id = "p-other";
    expect((await apply()).code).toBe("model_plan_project_binding_missing");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("finds exact bank id on a later listing page", async () => {
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (url.includes("offset=0"))
        return response({
          banks: Array.from({ length: 100 }, (_, i) => ({ bank_id: `other-${i}`, name: "其他" })),
          total: 101,
        });
      return original(url, init);
    });
    expect((await apply()).ok).toBe(true);
    expect(fetchMock.mock.calls.some((c) => c[0].includes("offset=100"))).toBe(true);
    expect(fetchMock.mock.calls.some((c) => c[0].endsWith("/profile"))).toBe(false);
  });
  it("bounds GET response bodies before any writes", async () => {
    fetchMock.mockResolvedValue(new Response("x".repeat(1024 * 1024 + 1)));
    expect((await apply()).code).toBe("model_plan_response_too_large");
    expect(posts).toHaveLength(0);
  });
  it("cancels non-success bodies without exposing content", async () => {
    const cancel = vi.fn();
    fetchMock.mockResolvedValue(new Response(new ReadableStream({ cancel }), { status: 403 }));
    expect((await apply()).code).toBe("model_plan_request_failed");
    expect(cancel).toHaveBeenCalledOnce();
    expect(posts).toHaveLength(0);
  });
  it("rejects a different stored tags_match policy", async () => {
    existing();
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      const r = await original(url, init);
      if (!url.includes("mental-models")) return r;
      const body = await r.json();
      body.trigger.tags_match = "all_strict";
      return response(body);
    });
    expect((await apply()).code).toBe("model_plan_name_conflict");
    expect(posts).toHaveLength(0);
  });
  it.each(["测试项目是什么？", "项目模块结构是什么？"])(
    "rejects omitted scope or project name before requests: %s",
    async (query) => {
      plan.models[0].source_query = query;
      expect((await apply()).code).toBe("model_plan_scope_missing");
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );
  it("rejects a changed scope with an unchanged source query before skipping", async () => {
    existing();
    plan.models[0].scope = "最新部署范围";
    expect((await apply()).code).toBe("model_plan_scope_missing");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("rejects stored tag_groups that override the approved flat tag scope", async () => {
    existing();
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      const r = await original(url, init);
      if (!url.includes("mental-models")) return r;
      const body = await r.json();
      body.trigger.tag_groups = [{ tags: ["other-scope"] }];
      return response(body);
    });
    expect((await apply()).code).toBe("model_plan_name_conflict");
    expect(posts).toHaveLength(0);
  });
  it("explicitly clears bank-default tag_groups on creation", async () => {
    expect((await apply()).ok).toBe(true);
    expect(posts[0]).toMatchObject({ trigger: { tag_groups: null, tags_match: "all" } });
  });
});
