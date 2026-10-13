import { beforeEach, describe, expect, it, vi } from "vitest";

const remote = vi.hoisted(() => ({
  catalog: vi.fn(),
  rules: vi.fn(),
  call: vi.fn(),
  native: vi.fn(),
  pending: vi.fn(),
}));
vi.mock("./core/remote-mcp-bridge", () => ({
  fetchRemoteCatalog: remote.catalog,
  fetchRemoteRules: remote.rules,
  callRemoteTool: remote.call,
}));
vi.mock("./core/host-client", () => ({
  loadHostConfig: () => ({ remoteMcpConfigFile: "/private/remote.json" }),
}));
vi.mock("./core/runtime", () => ({ RuntimeCore: remote.native }));
vi.mock("./core/conclusions", () => ({ pendingConclusionWorkspaces: remote.pending }));
import { apply } from "./dsh";

function host() {
  const listeners = new Map<string, (...args: any[]) => any>();
  const tools = new Map<string, any>();
  const disposers: (() => void)[] = [];
  const ctx = {
    effect: (fn: () => () => void) => {
      disposers.push(fn());
    },
    on: (name: string, fn: (...args: any[]) => any) => {
      listeners.set(name, fn);
    },
    inject: async (_names: string[], fn: (ctx: any) => Promise<void>) => {
      await fn({ tools: { register: (tool: any) => tools.set(tool.name, tool) } });
    },
  };
  return { ctx, listeners, tools, dispose: () => disposers.forEach((fn) => fn()) };
}
const agent = (cwd?: string, mode: "normal" | "plan" | "unknown" = "normal") => ({
  session: { header: { id: cwd ?? "missing", cwd } },
  ctx: {
    get: (name: string) =>
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
  remote.catalog.mockResolvedValue({
    instructions: "NAS",
    bankId: "p-a",
    tools: [
      {
        name: "hindsight_recall",
        description: "NAS 查询规则",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
      {
        name: "hindsight_save_conclusion",
        description: "NAS 写入规则",
        inputSchema: {
          type: "object",
          properties: { content: { type: "string" } },
          required: ["content"],
        },
      },
      {
        name: "hindsight_read_knowledge_page",
        description: "NAS 知识页",
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

describe("DSH NAS-only adapter", () => {
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
    expect(h.listeners.has("agent/session-start")).toBe(false);
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
