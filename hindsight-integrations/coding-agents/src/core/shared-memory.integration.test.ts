import { INSTALLERS, type InstallCtx } from "../installer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { importProjects, resolveRegisteredProject } from "./project-registry";
import { resolveConfig } from "./config";
import { RuntimeCore } from "./runtime";
import { resolveHostMemory } from "./host-client";
import { sharedRecall, outputTokens } from "./shared-recall";
import { buildHookOutput } from "./hook";
import { buildKnowledgeTools } from "./knowledge-tools";
import { cleanArguments, signToolContext, verifyToolContext } from "./tool-context";
import { saveConclusion, retryConclusions, conclusionStatus } from "./conclusions";
import { buildPageTrigger } from "./missions";
import { selectTools } from "../mcp-server";
import { apply as applyDsh } from "../dsh";

let temp: string, project: string, registry: string, config: string;
let server: Server | undefined;
beforeEach(() => {
  temp = mkdtempSync("/tmp/hs-shared-");
  project = join(temp, "project");
  mkdirSync(project);
  registry = join(temp, "projects.json");
  config = join(temp, "config.json");
  writeFileSync(
    registry,
    JSON.stringify({
      projects: [{ root: project, bankId: "p-project", name: "Project", enabled: true }],
    })
  );
  writeFileSync(
    config,
    JSON.stringify({
      bankResolution: "registry",
      projectRegistryFile: registry,
      serverMode: "self-hosted",
    })
  );
  vi.stubEnv("HINDSIGHT_CONFIG", config);
  vi.stubEnv("HINDSIGHT_SHARED_STATE_DIR", join(temp, "state"));
  vi.stubEnv("HINDSIGHT_CONTEXT_KEY_FILE", join(temp, "context.key"));
});
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  }
  vi.unstubAllEnvs();
  rmSync(temp, { recursive: true, force: true });
});
interface RequestLog {
  path: string;
  method: string;
  body: Record<string, unknown>;
}
async function api() {
  const calls: RequestLog[] = [],
    pages: { id: string; name: string; kind: string; description?: string }[] = [];
  const state = { complete: false, strategy: true, offline: false, bankExists: true };
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length
      ? (JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>)
      : {};
    const path = new URL(req.url!, "http://localhost").pathname;
    calls.push({ path, method: req.method!, body });
    res.setHeader("content-type", "application/json");
    const send = (value: unknown, code = 200) => {
      res.statusCode = code;
      res.end(JSON.stringify(value));
    };
    if (state.offline) return send({ error: "temporary" }, 503);
    if (path === "/version") return send({ api_version: "0.10.1" });
    if (path.endsWith("/stats"))
      return send(
        { bank_id: decodeURIComponent(path.split("/")[4]) },
        state.bankExists ? 200 : 404
      );
    if (path.endsWith("/config"))
      return send({
        config: {
          retain_strategies: state.strategy
            ? {
                project_conclusions_v1: {
                  retain_extraction_mode: "concise",
                  retain_mission: "Keep durable evidence-backed conclusions",
                },
              }
            : {},
        },
      });
    if (path.endsWith("/memories") && req.method === "POST")
      return send({ operation_id: body.operation_id });
    if (path.includes("/operations/"))
      return send({ status: state.complete ? "completed" : "processing" });
    if (path.endsWith("/knowledge-base/tree"))
      return send({ roots: [{ kind: "folder", name: "existing", children: pages }] });
    if (path.endsWith("/knowledge-base/pages") && req.method === "POST") {
      pages.push({
        id: `page-${pages.length}`,
        kind: "page",
        name: String(body.name),
        description: String(body.source_query),
      });
      return send({ id: pages.at(-1)!.id });
    }
    if (path.endsWith("/knowledge-base/search"))
      return send({
        results: [
          {
            id: "page",
            name: "Hindsight",
            snippet: "Hindsight project uses explicit mappings",
            score: 1,
          },
        ],
      });
    if (path.endsWith("/knowledge-base/pages")) return send({ items: pages });
    if (path.endsWith("/memories/recall"))
      return send({
        results: [
          { id: "fact", text: "Hindsight project uses explicit mappings", type: "observation" },
        ],
      });
    return send({ detail: "Not Found" }, 404);
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  const address = server.address() as { port: number };
  writeFileSync(
    config,
    JSON.stringify({
      bankResolution: "registry",
      projectRegistryFile: registry,
      apiUrl: `http://127.0.0.1:${address.port}`,
      serverMode: "self-hosted",
    })
  );
  return { calls, pages, state, memory: resolveHostMemory("codex", project) };
}

describe("independent project registry", () => {
  it("imports runtime overrides, skips mirrors and refuses to overwrite", () => {
    const a = join(temp, "a.json"),
      b = join(temp, "b.json"),
      out = join(temp, "import.json");
    writeFileSync(
      a,
      JSON.stringify({
        projects: [
          { root: project, wiki_name: "old" },
          { root: join(temp, "mirror"), wiki_name: "mirror", kind: "mirror" },
        ],
      })
    );
    writeFileSync(
      b,
      JSON.stringify({
        projects: [
          { root: project, wikiName: "p-dsh", project: "dsh" },
          { root: join(temp, "other"), wikiName: "p-other" },
        ],
      })
    );
    expect(importProjects([a, b], ["p-dsh"], out)).toEqual([
      { root: join(temp, "other"), bankId: "p-other", enabled: false, name: undefined },
      { root: project, bankId: "p-dsh", enabled: true, name: "dsh" },
    ]);
    expect(() => importProjects([a, b], ["p-dsh"], out)).toThrow("registry_already_exists");
  });
  it("handles non-Git children, boundaries and disabled deeper mappings", () => {
    const child = join(project, "child");
    mkdirSync(child);
    const sibling = join(temp, "project-other");
    mkdirSync(sibling);
    expect(resolveRegisteredProject(child, registry).bankId).toBe("p-project");
    expect(() => resolveRegisteredProject(sibling, registry)).toThrow("project_unregistered");
    writeFileSync(
      registry,
      JSON.stringify({
        projects: [
          { root: project, bankId: "p-project", enabled: true },
          { root: child, bankId: "p-child", enabled: false },
        ],
      })
    );
    expect(() => resolveRegisteredProject(child, registry)).toThrow("project_disabled");
  });
  it("canonicalizes symlinks and supports Chinese bank identifiers", () => {
    const alias = join(temp, "alias");
    symlinkSync(project, alias);
    writeFileSync(
      registry,
      JSON.stringify({ projects: [{ root: project, bankId: "p-中文项目", enabled: true }] })
    );
    expect(resolveRegisteredProject(alias, registry).bankId).toBe("p-中文项目");
  });
  it("maps worktree children to their source project", () => {
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", project, ...args], { stdio: "pipe" });
    git("init", "-q");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--allow-empty",
      "-qm",
      "fixture"
    );
    const linked = join(temp, "linked");
    git("worktree", "add", "--detach", "-q", linked);
    mkdirSync(join(linked, "child"));
    expect(resolveRegisteredProject(join(linked, "child"), registry).bankId).toBe("p-project");
  });
  it("uses the same bank across four hosts without fallback", () => {
    for (const harness of ["codex", "claude-code", "dsh", "pi"])
      expect(resolveHostMemory(harness, project).bankId).toBe("p-project");
    const other = join(temp, "unknown");
    mkdirSync(other);
    expect(resolveHostMemory("codex", other).cfg.disabled).toBe(true);
    writeFileSync(registry, "invalid JSON");
    expect(resolveHostMemory("pi", project).cfg.disabled).toBe(true);
  });
  it("fails closed on invalid private config instead of falling back to a cloud endpoint", () => {
    writeFileSync(config, "invalid JSON");
    vi.stubEnv("HINDSIGHT_BANK_RESOLUTION", "registry");
    expect(resolveHostMemory("codex", project).cfg.disabled).toBe(true);
  });
  it("defaults to registry routing and disables all automatic ingestion", () => {
    vi.stubEnv("HINDSIGHT_BANK_RESOLUTION", undefined);
    const cfg = resolveConfig();
    expect(cfg.bankResolution).toBe("registry");
    expect([
      cfg.retainSessions,
      cfg.autoSeed,
      cfg.codebaseSurvey,
      cfg.autoUpdate,
      cfg.manageBankConfig,
    ]).toEqual([false, false, false, false, false]);
    expect(cfg.gitIngest).toBe("none");
    expect(cfg.autoInject).toBe("recall");
    expect(cfg.injectTimeoutMs).toBe(7000);
    expect(cfg.pageTriggerType).toBe("cron");
  });
});

it("installs four hosts in an isolated home with signed-context hooks and native entries", () => {
  const home = join(temp, "isolated-home");
  mkdirSync(home);
  vi.stubEnv("DSH_HOME", join(home, ".dsh"));
  const ctx: InstallCtx = {
    home,
    pkgRoot: process.cwd(),
    dist: join(process.cwd(), "dist"),
    claudeMcp: vi.fn(() => true),
    interactive: false,
    nodeSqlite: () => true,
  };
  for (const name of ["codex", "claude-code", "dsh", "pi"])
    INSTALLERS.find((i) => i.name === name)!.install(ctx);
  for (const name of ["codex", "claude-code"]) {
    const file =
      name === "codex"
        ? join(home, ".codex", "hooks.json")
        : join(home, ".claude", "settings.json");
    const hooks = JSON.parse(readFileSync(file, "utf8")).hooks;
    const context = hooks.PreToolUse[0].hooks[0].command;
    expect(context).toContain("shared-context-hook.js");
    expect(context).toContain(name);
    expect(hooks.UserPromptSubmit[0].hooks[0].timeout).toBeGreaterThanOrEqual(12);
  }
  expect(readFileSync(join(home, ".dsh", "cordis.patch.yml"), "utf8")).toContain("dsh.js");
  expect(readFileSync(join(home, ".pi", "agent", "settings.json"), "utf8")).toContain("pi.js");
});

describe("bounded per-turn recall", () => {
  it("keeps a fast result when the other arm exceeds the shared deadline", async () => {
    const client = {
      recallObservations: () => new Promise<string[]>(() => {}),
      searchKnowledgePages: async () => [{ snippet: "Hindsight project uses explicit mappings" }],
    };
    const start = Date.now(),
      result = await sharedRecall(client, "Hindsight project mapping", undefined, 35);
    expect(result.text).toContain("explicit mappings");
    expect(Date.now() - start).toBeLessThan(500);
    expect(result.sources).toEqual(["knowledge"]);
  });
  it("skips acknowledgements, preserves follow-up topic and bounds tokens", async () => {
    const recall = vi.fn(async () => ["Hindsight mapping ".repeat(5000)]),
      search = vi.fn(async () => []);
    const client = { recallObservations: recall, searchKnowledgePages: search };
    await sharedRecall(client, "好的", undefined, 50);
    expect(recall).not.toHaveBeenCalled();
    const initial = await sharedRecall(client, "Hindsight 项目映射有什么问题", undefined, 50);
    const follow = await sharedRecall(client, "这个怎么修改", initial.topic, 50);
    expect(follow.reason).toBe("followup");
    expect(outputTokens(follow.text)).toBeLessThanOrEqual(2000);
  });
  it("rebinds a persistent host after the mapping changes and drops old topic context", async () => {
    const f = await api(),
      core = new RuntimeCore(f.memory.client, "p-project", f.memory.cfg, "pi", project);
    const session = "hot-" + temp.split("/").at(-1);
    try {
      await core.onPrompt(session, "Hindsight project mapping");
      expect(core.getInjection(session)).toContain("p-project");
      writeFileSync(
        registry,
        JSON.stringify({ projects: [{ root: project, bankId: "p-rebound", enabled: true }] })
      );
      await core.onPrompt(session, "这个怎么修改");
      expect(core.getInjection(session)).toBeFalsy();
      await core.onPrompt(session, "Hindsight project mapping");
      expect(core.getInjection(session)).toContain("p-rebound");
      expect(f.calls.some((c) => c.path.includes("/p-rebound/"))).toBe(true);
    } finally {
      core.dispose();
    }
  });
  it("runs on distinct turns but never repeats a supplied turn id", async () => {
    const fixture = await api(),
      cfg = fixture.memory.cfg,
      cacheFile = join(temp, "session.json");
    const args = {
      harness: "codex",
      prompt: "Hindsight project mapping",
      cfg,
      client: fixture.memory.client,
      cacheFile,
    };
    await buildHookOutput({ ...args, turnId: "one" });
    await buildHookOutput({ ...args, turnId: "one" });
    await buildHookOutput({ ...args, turnId: "two" });
    expect(fixture.calls.filter((c) => c.path.endsWith("/memories/recall"))).toHaveLength(2);
  });
});

describe("context and durable conclusions", () => {
  const conclusion = {
    content: "Project constraints are shared across agents.",
    evidence: "Fixture user explicitly requires shared constraints.",
  };
  it("binds tool name, input, workspace and permission with a signature", () => {
    const tool = "hindsight_save_conclusion",
      token = signToolContext(
        { cwd: project, harness: "codex", session: "s", mode: "plan", tool },
        conclusion
      );
    expect(verifyToolContext(token, tool, conclusion).mode).toBe("plan");
    expect(() => verifyToolContext(token, tool, { ...conclusion, content: "changed" })).toThrow(
      "expired_or_changed"
    );
    expect(() => verifyToolContext(token, "hindsight_reflect", conclusion)).toThrow(
      "expired_or_changed"
    );
    expect(cleanArguments({ ...conclusion, _context: token })).toEqual(conclusion);
  });
  it("rejects writes in plan and unknown mode before any request", async () => {
    const f = await api(),
      tool = buildKnowledgeTools(f.memory.client, "p-project").find(
        (t) => t.name === "hindsight_save_conclusion"
      )!;
    expect((await tool.handler(conclusion, { permission: "plan" })).isError).toBe(true);
    expect((await tool.handler(conclusion)).isError).toBe(true);
    expect(f.calls).toHaveLength(0);
    for (const name of ["hindsight_ingest_document", "hindsight_capture_initiative"])
      expect(
        (
          await buildKnowledgeTools(f.memory.client, "p-project")
            .find((t) => t.name === name)!
            .handler({}, { permission: "plan" })
        ).isError
      ).toBe(true);
  });
  it("deduplicates across hosts, polls receipts and recovers after reopening", async () => {
    const f = await api(),
      a = await saveConclusion(f.memory.client, conclusion, "codex");
    expect(a.state).toBe("submitted");
    const b = await saveConclusion(
      resolveHostMemory("claude-code", project).client,
      conclusion,
      "claude-code"
    );
    expect(b.id).toBe(a.id);
    expect(b.deduplicated).toBe(true);
    expect(f.calls.filter((c) => c.method === "POST" && c.path.endsWith("/memories"))).toHaveLength(
      1
    );
    f.state.complete = true;
    await retryConclusions(resolveHostMemory("dsh", project).client);
    expect(conclusionStatus(f.memory.client)).toEqual([{ state: "completed", count: 1 }]);
  });
  it("resumes a persisted DSH save at plugin startup without a session or model turn", async () => {
    const f = await api();
    f.state.offline = true;
    expect((await saveConclusion(f.memory.client, conclusion, "dsh")).state).toBe("pending");
    f.state.offline = false;
    f.state.complete = true;
    let dispose: (() => void) | undefined;
    applyDsh({
      on: () => {},
      inject: () => {},
      effect: (effect) => {
        dispose = effect();
      },
    });
    try {
      await vi.waitFor(() =>
        expect(conclusionStatus(f.memory.client)).toEqual([{ state: "completed", count: 1 }])
      );
      expect(
        f.calls.filter((c) => c.method === "POST" && c.path.endsWith("/memories"))
      ).toHaveLength(1);
      expect(f.pages).toHaveLength(0);
    } finally {
      dispose?.();
    }
  });
  it("never falls back when the conclusion strategy is absent", async () => {
    const f = await api();
    f.state.strategy = false;
    expect((await saveConclusion(f.memory.client, conclusion, "codex")).state).toBe("failed");
    expect(f.calls.some((c) => c.method === "POST" && c.path.endsWith("/memories"))).toBe(false);
    await expect(
      saveConclusion(f.memory.client, { content: "missing evidence" }, "codex")
    ).rejects.toThrow();
  });
  it("retries a disconnected submission but never retargets after remapping", async () => {
    const f = await api();
    f.state.offline = true;
    expect((await saveConclusion(f.memory.client, conclusion, "codex")).state).toBe("pending");
    f.state.offline = false;
    await retryConclusions(f.memory.client);
    expect(conclusionStatus(f.memory.client)).toEqual([{ state: "submitted", count: 1 }]);
    writeFileSync(
      registry,
      JSON.stringify({ projects: [{ root: project, bankId: "another", enabled: true }] })
    );
    const before = f.calls.length;
    await retryConclusions(f.memory.client);
    expect(f.calls).toHaveLength(before);
    expect(conclusionStatus(f.memory.client)).toEqual([{ state: "failed", count: 1 }]);
  });
  it("quarantines a pending conclusion when credential identity changes", async () => {
    const f = await api();
    f.state.offline = true;
    await saveConclusion(f.memory.client, conclusion, "codex");
    const value = JSON.parse(readFileSync(config, "utf8"));
    value.apiToken = "fixture-new-tenant";
    writeFileSync(config, JSON.stringify(value));
    const before = f.calls.length;
    await retryConclusions(resolveHostMemory("codex", project).client);
    expect(f.calls).toHaveLength(before);
    expect(conclusionStatus(resolveHostMemory("codex", project).client)).toEqual([]);
  });
  it("never contacts an implicit cloud default when the service endpoint is missing", async () => {
    writeFileSync(
      config,
      JSON.stringify({ bankResolution: "registry", projectRegistryFile: registry })
    );
    const bound = resolveHostMemory("codex", project).client;
    await expect(bound.listPages()).rejects.toThrow("memory_endpoint_not_configured");
    await expect(saveConclusion(bound, conclusion, "codex")).rejects.toThrow(
      "memory_endpoint_not_configured"
    );
    expect(() => resolveConfig({ bankResolution: "typo" as "registry" })).toThrow(
      "invalid_bank_resolution"
    );
  });
  it("binds MCP calls from an unrelated launch directory through the trusted hook", async () => {
    const f = await api(),
      catalog = selectTools(f.memory.cfg, f.memory.client, "p-project", {
        cwd: temp,
        harness: "codex",
      });
    const read = catalog.find((t) => t.name === "hindsight_list_knowledge_pages")!;
    expect((await read.handler({})).isError).toBe(true);
    const token = signToolContext(
      { cwd: project, harness: "codex", session: "s", mode: "plan", tool: read.name },
      {}
    );
    expect((await read.handler({ _context: token })).isError).not.toBe(true);
    expect(f.calls.some((c) => c.path.includes("/p-project/"))).toBe(true);
  });
  it("refuses an absent remote bank before any mutation", async () => {
    const f = await api();
    f.state.bankExists = false;
    await expect(f.memory.client.seedPages()).rejects.toThrow("project_bank_missing");
    expect(f.calls.some((c) => c.method !== "GET")).toBe(false);
  });
});

it("initializes five pages once, finds nested existing pages and never overwrites them", async () => {
  const f = await api();
  await f.memory.client.seedPages(buildPageTrigger(f.memory.cfg));
  expect(f.pages).toHaveLength(5);
  const original = JSON.parse(JSON.stringify(f.pages));
  f.pages[0].description = "operator's custom question";
  await f.memory.client.seedPages(buildPageTrigger(f.memory.cfg));
  expect(f.pages).toHaveLength(5);
  expect(f.pages[0].description).toBe("operator's custom question");
  expect(f.calls.some((c) => c.method === "PATCH")).toBe(false);
  for (const call of f.calls.filter(
    (c) => c.method === "POST" && c.path.endsWith("/knowledge-base/pages")
  ))
    expect((call.body.trigger as { refresh_cron: string }).refresh_cron).toMatch(
      /^\d+ \* \* \* \*$/
    );
  expect(original).toHaveLength(5);
});
