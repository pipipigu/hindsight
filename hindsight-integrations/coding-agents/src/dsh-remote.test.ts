import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const remote = vi.hoisted(() => ({
  catalog: vi.fn(),
  rules: vi.fn(),
  call: vi.fn(),
  native: vi.fn(),
  pending: vi.fn(),
  local: false,
}));
vi.mock("./core/remote-mcp-bridge", () => ({
  fetchRemoteCatalog: remote.catalog,
  fetchRemoteRules: remote.rules,
  callRemoteTool: remote.call,
}));
vi.mock("./core/host-client", () => ({
  loadHostConfig: () =>
    remote.local ? { bankResolution: "upstream" } : { remoteMcpConfigFile: "/private/remote.json" },
  resolveHostMemory: () => ({ cfg: { bankResolution: "upstream" }, bankId: "local", client: {} }),
}));
vi.mock("./core/runtime", () => ({ RuntimeCore: remote.native }));
vi.mock("./core/conclusions", () => ({ pendingConclusionWorkspaces: remote.pending }));
import { apply } from "./dsh";
import { buildKnowledgeTools } from "./core/knowledge-tools";
import { HindsightClient } from "./core/hindsight";

function host() {
  type Listener = (...args: any[]) => any;
  const handlers = new Map<string, Listener[]>();
  const listeners = new Map<string, Listener>();
  const tools = new Map<string, any>();
  const guards = new Set<(execution: any) => string | undefined>();
  const disposers: (() => void)[] = [];
  const ctx = {
    effect: (fn: () => () => void) => {
      disposers.push(fn());
    },
    on: (name: string, fn: Listener, options?: { prepend?: boolean }) => {
      const registered = handlers.get(name) ?? [];
      if (options?.prepend) registered.unshift(fn);
      else registered.push(fn);
      handlers.set(name, registered);
      // Cordis preserves all listeners and composes pre-step middleware around next().
      listeners.set(name, (...args) => {
        const current = [...(handlers.get(name) ?? [])];
        if (name === "agent/pre-step") {
          const [payload, next] = args;
          return current.reduceRight<() => Promise<any>>(
            (next, listener) => () => listener(payload, next),
            next
          )();
        }
        for (const listener of current) listener(...args);
      });
      return () => {
        const index = registered.indexOf(fn);
        if (index >= 0) registered.splice(index, 1);
      };
    },
    inject: async (_names: string[], fn: (ctx: any) => Promise<void>) => {
      await fn({
        ...ctx,
        tools: {
          register: (tool: any) => tools.set(tool.name, tool),
          guard: (guard: (execution: any) => string | undefined) => {
            guards.add(guard);
            return () => guards.delete(guard);
          },
        },
      });
    },
  };
  return { ctx, listeners, tools, guards, dispose: () => disposers.forEach((fn) => fn()) };
}
const agent = (cwd?: string, mode: "normal" | "plan" | "unknown" = "normal", origin?: string) => ({
  session: { header: { id: cwd ?? "missing", cwd, origin } },
  ctx: {
    get: (name: string): unknown =>
      name === "planMode" && mode !== "unknown"
        ? { get: () => ({ active: mode === "plan" }) }
        : undefined,
  },
});
const message = (text: string, kind = "user") => ({
  id: text,
  role: "user",
  source: { kind },
  content: [{ type: "text", text }],
});
const step = (
  h: ReturnType<typeof host>,
  a: ReturnType<typeof agent>,
  turn: number,
  messages: unknown[]
) =>
  h.listeners.get("agent/pre-step")!(
    { agent: a, turn, signal: new AbortController().signal },
    async () => ({ kind: "enter", messages })
  );

beforeEach(() => {
  vi.clearAllMocks();
  remote.local = false;
  vi.stubEnv("HINDSIGHT_MEMORY_ACCESS", "");
  remote.catalog.mockResolvedValue({
    instructions: "NAS",
    bankId: "p-a",
    tools: [
      {
        name: "hindsight_recall",
        description: "NAS 查询规则",
        annotations: { readOnlyHint: true },
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
      {
        name: "hindsight_save_conclusion",
        description: "NAS 写入规则",
        annotations: { readOnlyHint: false },
        inputSchema: {
          type: "object",
          properties: { content: { type: "string" } },
          required: ["content"],
        },
      },
      {
        name: "hindsight_ingest_document",
        description: "NAS 文档写入",
        annotations: { readOnlyHint: false },
        inputSchema: { type: "object", properties: { content: { type: "string" } } },
      },
      {
        name: "hindsight_read_knowledge_page",
        description: "NAS 知识页",
        annotations: { readOnlyHint: true },
        inputSchema: { type: "object", properties: { page_id: { type: "string" } } },
      },
    ],
  });
  remote.rules.mockImplementation(async (_h, cwd) =>
    cwd === "/unmapped" ? null : `NAS规则:${cwd}`
  );
  remote.call.mockImplementation(async (_h, cwd, mode, name) => {
    if (name === "hindsight_save_conclusion" && mode !== "normal")
      throw new Error("remote_write_permission_denied");
    return { content: [{ type: "text", text: cwd }] };
  });
});

afterEach(() => vi.unstubAllEnvs());

it("hides every local write tool, including initiative capture, from the child catalog", async () => {
  remote.local = true;
  const catalog = buildKnowledgeTools(
    new HindsightClient({ apiUrl: "http://fixture", bank: "local" }),
    "local"
  );
  remote.native.mockImplementation(function () {
    return {
      toolSpecs: () => catalog,
      seedIfCold: vi.fn(async () => {}),
      setTranscriptSource: vi.fn(),
      dispose: vi.fn(),
    };
  });
  const h = host();
  await apply(h.ctx as never);
  function caller(origin?: string) {
    const denied = new Set<string>();
    const a = agent(process.cwd(), "normal", origin);
    const scopedTools = {
      schemas: () =>
        [...h.tools.keys()].filter((name) => !denied.has(name)).map((name) => ({ name })),
      restrict: ({ deny }: { deny: string[] }) => {
        for (const name of deny) denied.add(name);
        return () => {
          for (const name of deny) denied.delete(name);
        };
      },
    };
    const get = a.ctx.get;
    a.ctx.get = (name) => (name === "tools" ? scopedTools : get(name));
    return { agent: a, names: () => scopedTools.schemas().map((tool) => tool.name) };
  }
  const main = caller(),
    child = caller("subagent");
  h.listeners.get("agent/session-start")!({ agent: main.agent });
  h.listeners.get("agent/session-start")!({ agent: child.agent });
  expect(main.names()).toContain("hindsight_capture_initiative");
  expect(child.names()).not.toContain("hindsight_capture_initiative");
  expect(child.names()).toEqual(
    catalog.filter((tool) => tool.annotations.readOnlyHint === true).map((tool) => tool.name)
  );
  expect([...h.guards][0]({ name: "hindsight_capture_initiative", agent: child.agent })).toBe(
    "memory_readonly"
  );
  await expect(
    h.tools.get("hindsight_capture_initiative").execute({}, { agent: child.agent })
  ).rejects.toThrow("memory_readonly");
  h.listeners.get("agent/disposed")!({ agent: main.agent });
  h.listeners.get("agent/disposed")!({ agent: child.agent });
  h.dispose();
});

describe("DSH NAS-only adapter", () => {
  it("masks child writes on lifecycle events, tracks catalog changes and releases restrictions", async () => {
    const h = host();
    await apply(h.ctx as never);
    function scoped(origin?: string) {
      const caller = agent("/shared", "normal", origin);
      const denied = new Set<string>();
      const releases: ReturnType<typeof vi.fn>[] = [];
      const scopedTools = {
        schemas: () =>
          [...h.tools.keys()].filter((name) => !denied.has(name)).map((name) => ({ name })),
        restrict: vi.fn(({ deny }: { deny: string[] }) => {
          for (const name of deny) denied.add(name);
          h.listeners.get("tools/change")!();
          const release = vi.fn(() => {
            for (const name of deny) denied.delete(name);
            h.listeners.get("tools/change")!();
          });
          releases.push(release);
          return release;
        }),
      };
      const get = caller.ctx.get;
      caller.ctx.get = (name) => (name === "tools" ? scopedTools : get(name));
      return { caller, denied, scopedTools, releases };
    }
    const main = scoped(),
      child = scoped("subagent"),
      restored = scoped("subagent");
    const ingest = h.tools.get("hindsight_ingest_document");
    h.tools.delete(ingest.name);
    h.listeners.get("agent/session-start")!({ agent: main.caller });
    h.listeners.get("agent/session-start")!({ agent: child.caller });
    expect(main.scopedTools.restrict).not.toHaveBeenCalled();
    expect([...child.denied]).toEqual(["hindsight_save_conclusion"]);
    h.tools.set(ingest.name, ingest);
    h.listeners.get("tools/change")!();
    expect([...child.denied]).toEqual(["hindsight_save_conclusion", "hindsight_ingest_document"]);
    expect(child.scopedTools.restrict).toHaveBeenCalledTimes(2);
    const decision = await step(h, restored.caller, 1, [message("restored")]);
    expect([...restored.denied]).toEqual([
      "hindsight_save_conclusion",
      "hindsight_ingest_document",
    ]);
    // Both pre-step listeners run: masking must not replace the existing rules injection.
    expect(decision.messages.at(-1).content[0].text).toContain("NAS规则:/shared");
    const guard = [...h.guards][0];
    for (const name of ["hindsight_save_conclusion", "hindsight_ingest_document"]) {
      expect(guard({ name, agent: child.caller })).toBe("memory_readonly");
      expect(guard({ name, agent: main.caller })).toBeUndefined();
    }
    expect(guard({ name: "hindsight_recall", agent: child.caller })).toBeUndefined();
    h.listeners.get("agent/disposed")!({ agent: child.caller });
    expect(child.denied.size).toBe(0);
    expect(child.releases.every((release) => release.mock.calls.length === 1)).toBe(true);
    h.dispose();
    expect(restored.denied.size).toBe(0);
    expect(restored.releases.every((release) => release.mock.calls.length === 1)).toBe(true);
    expect(h.guards.size).toBe(0);
    h.listeners.get("agent/session-start")!({ agent: child.caller });
    expect(child.scopedTools.restrict).toHaveBeenCalledTimes(2);
  });
  it("isolates concurrent main and subagent memory authority in the same directory", async () => {
    const h = host();
    await apply(h.ctx as never);
    const main = agent("/shared"),
      child = agent("/shared", "normal", "subagent");
    const results = await Promise.allSettled([
      h.tools.get("hindsight_save_conclusion").execute({ content: "main" }, { agent: main }),
      h.tools.get("hindsight_save_conclusion").execute({ content: "child" }, { agent: child }),
      h.tools.get("hindsight_recall").execute({ query: "child" }, { agent: child }),
      h.tools.get("hindsight_recall").execute({ query: "main" }, { agent: main }),
    ]);
    expect(results.map((result) => result.status)).toEqual([
      "fulfilled",
      "rejected",
      "fulfilled",
      "fulfilled",
    ]);
    expect((results[1] as PromiseRejectedResult).reason.message).toBe("memory_readonly");
    const calls = remote.call.mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls.find((call) => call[4].query === "child")?.[6]).toBe("read-only");
    expect(calls.find((call) => call[4].query === "main")?.[6]).toBe("read-write");
    expect(calls.find((call) => call[4].content === "main")?.[6]).toBe("read-write");
    h.dispose();
  });
  it("rejects every repeated child write before transport while allowing knowledge reads", async () => {
    const h = host();
    await apply(h.ctx as never);
    const child = agent("/shared", "normal", "subagent");
    for (let turn = 1; turn <= 2; turn++) {
      await step(h, child, turn, [message(`turn-${turn}`)]);
      for (const name of ["hindsight_save_conclusion", "hindsight_ingest_document"]) {
        await expect(h.tools.get(name).execute({ content: "x" }, { agent: child })).rejects.toThrow(
          "memory_readonly"
        );
      }
    }
    expect(remote.call).not.toHaveBeenCalled();
    await expect(
      h.tools.get("hindsight_read_knowledge_page").execute({ page_id: "kp-1" }, { agent: child })
    ).resolves.toBe("/shared");
    expect(remote.call.mock.calls.at(-1)?.[6]).toBe("read-only");
    h.dispose();
  });
  it("injects child read-only instructions without changing the main session rules", async () => {
    const h = host();
    await apply(h.ctx as never);
    const [main, child] = await Promise.all([
      step(h, agent("/shared"), 1, [message("main")]),
      step(h, agent("/shared", "normal", "subagent"), 1, [message("child")]),
    ]);
    expect(main.messages.at(-1).content[0].text).toContain("NAS规则:/shared");
    expect(child.messages.at(-1).content[0].text).toMatch(/只读|read-only/);
    expect(main.messages.at(-1).content[0].text).not.toMatch(/只读|read-only/);
    h.dispose();
  });
  it("keeps inherited environment restrictions for ordinary sessions too", async () => {
    vi.stubEnv("HINDSIGHT_MEMORY_ACCESS", "read-only");
    const h = host();
    await apply(h.ctx as never);
    const main = agent("/shared");
    await expect(
      h.tools.get("hindsight_save_conclusion").execute({ content: "x" }, { agent: main })
    ).rejects.toThrow("memory_readonly");
    expect(remote.call).not.toHaveBeenCalled();
    await h.tools.get("hindsight_recall").execute({ query: "x" }, { agent: main });
    expect(remote.call.mock.calls.at(-1)?.[6]).toBe("read-only");
    h.dispose();
  });
  it("uses the short rules deadline on every remote pre-step", async () => {
    const h = host();
    await apply(h.ctx as never);
    const a = agent("/a");
    for (let turn = 1; turn <= 2; turn++) {
      await step(h, a, turn, [message(`question-${turn}`)]);
      expect(remote.rules).toHaveBeenLastCalledWith("dsh", "/a", expect.any(AbortSignal), 2500);
    }
    h.dispose();
  });
  it("awaits catalog initialization and uses untouched remote schema/description", async () => {
    const h = host();
    let release!: (value: unknown) => void;
    remote.catalog.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      })
    );
    const startup = apply(h.ctx as never);
    expect(h.tools.size).toBe(0);
    release({
      tools: [
        {
          name: "hindsight_recall",
          description: "NAS description",
          annotations: { readOnlyHint: true },
          inputSchema: { type: "object", properties: {} },
        },
      ],
    });
    await startup;
    expect(h.tools.get("hindsight_recall").description).toBe("NAS description");
    expect(h.tools.get("hindsight_recall").parameters).toEqual({ type: "object", properties: {} });
    h.dispose();
  });
  it("binds concurrent tools and rules to actual session directories, never process cwd", async () => {
    const h = host();
    await apply(h.ctx as never);
    const a = agent("/a"),
      b = agent("/b");
    const results = await Promise.all([
      step(h, a, 1, [message("a")]),
      step(h, b, 1, [message("b")]),
    ]);
    expect(results[0].messages.at(-1).content[0].text).toContain("NAS规则:/a");
    expect(results[1].messages.at(-1).content[0].text).toContain("NAS规则:/b");
    expect(
      await Promise.all([
        h.tools.get("hindsight_recall").execute({ query: "a" }, { agent: a }),
        h.tools.get("hindsight_recall").execute({ query: "b" }, { agent: b }),
      ])
    ).toEqual(["/a", "/b"]);
    expect(remote.native).not.toHaveBeenCalled();
    expect(remote.pending).not.toHaveBeenCalled();
    expect(h.listeners.has("agent/session-start")).toBe(true);
    h.listeners.get("agent/session-start")!({ agent: a });
    expect(remote.native).not.toHaveBeenCalled();
    expect(remote.pending).not.toHaveBeenCalled();
    expect(h.listeners.has("agent/turn-stopping")).toBe(false);
    h.dispose();
  });
  it("fetches changed NAS rules for new turns only; tool continuations and duplicate steps do not fetch", async () => {
    const h = host();
    await apply(h.ctx as never);
    const a = agent("/a");
    await step(h, a, 1, [message("first")]);
    await step(h, a, 1, [message("first")]);
    await step(h, a, 1, [message("continuation", "plugin")]);
    expect(remote.rules).toHaveBeenCalledTimes(1);
    remote.rules.mockResolvedValueOnce("NAS 新规则");
    const result = await step(h, a, 2, [message("second")]);
    expect(result.messages.at(-1).content[0].text).toContain("NAS 新规则");
    h.dispose();
  });
  it("unmapped rules stay absent and missing caller context never forwards", async () => {
    const h = host();
    await apply(h.ctx as never);
    expect((await step(h, agent("/unmapped"), 1, [message("question")])).messages).toHaveLength(1);
    await step(h, agent(), 1, [message("missing")]);
    expect(remote.rules).toHaveBeenCalledTimes(1);
    await expect(h.tools.get("hindsight_recall").execute({}, {})).rejects.toThrow(
      "remote_project_context_missing"
    );
    await expect(h.tools.get("hindsight_recall").execute({}, { agent: agent() })).rejects.toThrow(
      "remote_project_context_missing"
    );
    expect(remote.call).not.toHaveBeenCalled();
    h.dispose();
  });
  it("passes plan/unknown authority to the bridge and forwards knowledge pages unchanged", async () => {
    const h = host();
    await apply(h.ctx as never);
    for (const mode of ["plan", "unknown"] as const) {
      await expect(
        h.tools
          .get("hindsight_save_conclusion")
          .execute({ content: "x" }, { agent: agent("/a", mode) })
      ).rejects.toThrow("remote_write_permission_denied");
      expect(remote.call.mock.calls.at(-1)?.[2]).toBe(mode);
    }
    await h.tools
      .get("hindsight_read_knowledge_page")
      .execute({ page_id: "kp-1" }, { agent: agent("/b") });
    expect(remote.call.mock.calls.at(-1)?.slice(0, 5)).toEqual([
      "dsh",
      "/b",
      "normal",
      "hindsight_read_knowledge_page",
      { page_id: "kp-1" },
    ]);
    h.dispose();
  });
  it("reports only connection diagnostics on failure, never reuses previous rules", async () => {
    const h = host();
    await apply(h.ctx as never);
    const a = agent("/a");
    await step(h, a, 1, [message("first")]);
    remote.rules.mockRejectedValueOnce(new Error("offline"));
    const result = await step(h, a, 2, [message("second")]);
    expect(result.messages.at(-1).content[0].text).toContain("连接不可用");
    expect(result.messages.at(-1).content[0].text).not.toContain("NAS规则");
    h.dispose();
  });
  it("aborts in-flight session work on disposal and all connections on plugin unload", async () => {
    const h = host();
    await apply(h.ctx as never);
    const a = agent("/a");
    await h.tools.get("hindsight_recall").execute({ query: "x" }, { agent: a });
    const signal = remote.call.mock.calls.at(-1)?.[5] as AbortSignal;
    expect(signal.aborted).toBe(false);
    h.listeners.get("agent/disposed")!({ agent: a });
    expect(signal.aborted).toBe(true);
    const b = agent("/b");
    await step(h, b, 1, [message("b")]);
    const ruleSignal = remote.rules.mock.calls.at(-1)?.[2] as AbortSignal;
    h.dispose();
    expect(ruleSignal.aborted).toBe(true);
  });
});
