import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { resolveConfig } from "./core/config";
import { signToolContext } from "./core/tool-context";
import { buildRemoteMcpServer } from "./mcp-server";

const bridge = vi.hoisted(() => ({ catalog: vi.fn(), call: vi.fn() }));
vi.mock("./core/remote-mcp-bridge", () => ({
  fetchRemoteCatalog: bridge.catalog,
  callRemoteTool: bridge.call,
}));

const recall = "hindsight_recall";
let dir: string;
let originalKey: string | undefined;
const clients: Client[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "remote-stdio-"));
  originalKey = process.env.HINDSIGHT_CONTEXT_KEY_FILE;
  process.env.HINDSIGHT_CONTEXT_KEY_FILE = join(dir, "context.key");
  bridge.catalog.mockReset().mockResolvedValue({
    instructions: "NAS 保存和末尾统计规则",
    bankId: "p-dsh",
    tools: [
      {
        name: recall,
        description: "NAS 当前工具说明",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
        annotations: { readOnlyHint: true },
      },
    ],
  });
  bridge.call.mockReset().mockResolvedValue({ content: [{ type: "text", text: "NAS result" }] });
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  if (originalKey === undefined) delete process.env.HINDSIGHT_CONTEXT_KEY_FILE;
  else process.env.HINDSIGHT_CONTEXT_KEY_FILE = originalKey;
  rmSync(dir, { recursive: true, force: true });
});
async function connect(disabled = false) {
  const server = await buildRemoteMcpServer("codex", resolveConfig({ disabled }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "codex-app", version: "1" });
  clients.push(client);
  await client.connect(clientTransport);
  return { server, client };
}
function signed(
  args: Record<string, unknown>,
  mode: "normal" | "plan" | "unknown" = "normal",
  harness: "codex" | "claude-code" = "codex"
) {
  return {
    ...args,
    _context: signToolContext(
      { cwd: "/real/project", harness, session: "app-session", mode, tool: recall },
      args
    ),
  };
}

describe("NAS stdio adapter", () => {
  it("forwards NAS instructions and original JSON schema, hiding bank selection", async () => {
    const { client } = await connect();
    expect(client.getInstructions()).toBe("NAS 保存和末尾统计规则");
    const { tools } = await client.listTools();
    expect(tools[0].description).toBe("NAS 当前工具说明");
    expect(tools[0].annotations?.readOnlyHint).toBe(true);
    expect(tools[0].inputSchema).toMatchObject({
      required: ["query"],
      additionalProperties: false,
    });
    expect(tools[0].inputSchema.properties).not.toHaveProperty("bank_id");
    expect(tools[0].inputSchema.properties).toHaveProperty("_context");
  });
  it("rejects a library catalog instead of exposing arbitrary bank selection", async () => {
    bridge.catalog.mockResolvedValue({
      instructions: "NAS",
      tools: [
        {
          name: recall,
          inputSchema: { type: "object", properties: { bank_id: { type: "string" } } },
        },
      ],
    });
    await expect(connect()).rejects.toThrow("remote_project_catalog_required");
    expect(bridge.call).not.toHaveBeenCalled();
  });
  it("uses the signed actual workspace rather than the App launch directory", async () => {
    const cwd = vi.spyOn(process, "cwd").mockReturnValue("/home/user");
    try {
      const { client } = await connect();
      await client.callTool({ name: recall, arguments: signed({ query: "project facts" }) });
      expect(bridge.call).toHaveBeenCalledWith(
        "codex",
        "/real/project",
        "normal",
        recall,
        { query: "project facts" },
        expect.any(AbortSignal)
      );
    } finally {
      cwd.mockRestore();
    }
  });
  it("refuses unsigned, forged, changed and wrong-harness contexts before forwarding", async () => {
    const { client } = await connect();
    const changed = { ...signed({ query: "original" }), query: "changed" };
    for (const args of [
      { query: "facts" },
      { query: "facts", _context: "forged" },
      changed,
      signed({ query: "facts" }, "normal", "claude-code"),
    ]) {
      expect(await client.callTool({ name: recall, arguments: args })).toMatchObject({
        isError: true,
      });
    }
    expect(bridge.call).not.toHaveBeenCalled();
  });
  it("rejects model bank, cwd and token overrides even when signed", async () => {
    const { client } = await connect();
    for (const extra of [{ bank_id: "other" }, { cwd: "/other" }, { token: "secret" }]) {
      expect(
        await client.callTool({ name: recall, arguments: signed({ query: "facts", ...extra }) })
      ).toMatchObject({ isError: true });
    }
    expect(bridge.call).not.toHaveBeenCalled();
  });
  it("preserves trusted permission state for bridge write enforcement", async () => {
    const { client } = await connect();
    for (const mode of ["plan", "unknown"] as const) {
      await client.callTool({ name: recall, arguments: signed({ query: "facts" }, mode) });
      expect(bridge.call).toHaveBeenLastCalledWith(
        "codex",
        "/real/project",
        mode,
        recall,
        { query: "facts" },
        expect.any(AbortSignal)
      );
    }
  });
  it("rejects plan and unknown writes without entering the remote bridge", async () => {
    bridge.catalog.mockResolvedValue({
      instructions: "NAS",
      tools: [
        {
          name: "hindsight_save_conclusion",
          inputSchema: {
            type: "object",
            properties: { content: { type: "string" }, evidence: { type: "string" } },
          },
        },
      ],
    });
    const { client } = await connect();
    for (const mode of ["plan", "unknown"] as const) {
      const args = { content: "fact", evidence: "source" };
      const context = signToolContext(
        {
          cwd: "/real/project",
          harness: "codex",
          session: "app-session",
          mode,
          tool: "hindsight_save_conclusion",
        },
        args
      );
      expect(
        await client.callTool({
          name: "hindsight_save_conclusion",
          arguments: { ...args, _context: context },
        })
      ).toMatchObject({ isError: true });
    }
    expect(bridge.call).not.toHaveBeenCalled();
  });
  it.each(["hindsight_ingest_document", "hindsight_save_conclusion"])(
    "rejects plan and unknown %s even with a misleading read-only annotation",
    async (name) => {
      bridge.catalog.mockResolvedValue({
        instructions: "NAS",
        tools: [
          {
            name,
            annotations: { readOnlyHint: true },
            inputSchema: {
              type: "object",
              properties: { content: { type: "string" }, evidence: { type: "string" } },
            },
          },
        ],
      });
      const { client } = await connect();
      for (const mode of ["plan", "unknown"] as const) {
        const args = { content: "fact", evidence: "source" };
        const context = signToolContext(
          { cwd: "/real/project", harness: "codex", session: "app-session", mode, tool: name },
          args
        );
        expect(
          await client.callTool({ name, arguments: { ...args, _context: context } })
        ).toMatchObject({ isError: true });
      }
      expect(bridge.call).not.toHaveBeenCalled();
    }
  );
  it("allows explicitly authorized document import with signed normal permission", async () => {
    const name = "hindsight_ingest_document";
    bridge.catalog.mockResolvedValue({
      instructions: "NAS",
      tools: [
        {
          name,
          annotations: { readOnlyHint: false },
          inputSchema: {
            type: "object",
            properties: { content: { type: "string" }, title: { type: "string" } },
          },
        },
      ],
    });
    const { client } = await connect();
    const args = { title: "document", content: "verified source" };
    const context = signToolContext(
      {
        cwd: "/real/project",
        harness: "codex",
        session: "app-session",
        mode: "normal",
        tool: name,
      },
      args
    );
    await client.callTool({ name, arguments: { ...args, _context: context } });
    expect(bridge.call).toHaveBeenCalledWith(
      "codex",
      "/real/project",
      "normal",
      name,
      args,
      expect.any(AbortSignal)
    );
  });
  it("conservatively rejects unannotated tools in plan mode", async () => {
    bridge.catalog.mockResolvedValue({
      instructions: "NAS",
      tools: [
        {
          name: recall,
          inputSchema: { type: "object", properties: { query: { type: "string" } } },
        },
      ],
    });
    const { client } = await connect();
    expect(
      await client.callTool({ name: recall, arguments: signed({ query: "facts" }, "plan") })
    ).toMatchObject({ isError: true });
    expect(bridge.call).not.toHaveBeenCalled();
  });
  it("globally disabled mode has no catalog network or tools", async () => {
    const { client } = await connect(true);
    expect((await client.listTools()).tools).toEqual([]);
    expect(bridge.catalog).not.toHaveBeenCalled();
  });
  it("cancels all in-flight calls when stdio closes", async () => {
    const { server, client } = await connect();
    let signal: AbortSignal | undefined;
    bridge.call.mockImplementation(async (...args) => {
      signal = args[5];
      await new Promise<void>((resolve) =>
        signal!.addEventListener("abort", () => resolve(), { once: true })
      );
      return { content: [] };
    });
    const pending = client
      .callTool({ name: recall, arguments: signed({ query: "facts" }) })
      .catch(() => undefined);
    await vi.waitFor(() => expect(signal).toBeDefined());
    await server.close();
    expect(signal!.aborted).toBe(true);
    await pending;
  });
});
