import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const mock = vi.hoisted(() => ({
  connect: vi.fn(),
  call: vi.fn(),
  list: vi.fn(),
  close: vi.fn(),
  transport: vi.fn(),
}));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    connect = mock.connect;
    callTool = mock.call;
    listTools = mock.list;
    close = mock.close;
    getInstructions() {
      return "NAS canonical instructions";
    }
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {
    constructor(...args: unknown[]) {
      mock.transport(...args);
    }
  },
}));
import { callRemoteTool, fetchRemoteCatalog, fetchRemoteRules } from "./remote-mcp-bridge";
import { applyBankConfig, loadConfig, resolveConfig } from "./config";
let root: string, cfgFile: string, registry: string, secrets: string;
const readToken = "read-token-32-characters-minimum-123456";
const writeToken = "write-token-32-characters-minimum-12345";
function mappings(bank = "alpha") {
  writeFileSync(registry, JSON.stringify({ projects: [{ root, bankId: bank, enabled: true }] }));
}
function credentials() {
  writeFileSync(
    secrets,
    JSON.stringify({
      endpoint: "https://nas.example/mcp",
      projects: { codex: { alpha: { readToken, writeToken } } },
    }),
    { mode: 0o600 }
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  root = mkdtempSync(join(tmpdir(), "remote-bridge-"));
  cfgFile = join(root, "config.json");
  registry = join(root, "projects.json");
  secrets = join(root, "private.json");
  mappings();
  credentials();
  writeFileSync(
    cfgFile,
    JSON.stringify({
      bankResolution: "registry",
      projectRegistryFile: registry,
      remoteMcpConfigFile: secrets,
      toolGuideExtra: "LOCAL MUST NOT APPEAR",
    })
  );
  vi.stubEnv("HINDSIGHT_CONFIG", cfgFile);
  mock.connect.mockResolvedValue(undefined);
  mock.close.mockResolvedValue(undefined);
  mock.list.mockResolvedValue({
    tools: [
      {
        name: "hindsight_recall",
        description: "NAS description",
        annotations: { readOnlyHint: true },
        inputSchema: { type: "object" },
      },
    ],
  });
  mock.call.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
describe("NAS workspace bridge", () => {
  it("only initializes for canonical remote rules, with project/harness headers", async () => {
    expect(await fetchRemoteRules("codex", root)).toBe("NAS canonical instructions");
    expect(mock.list).not.toHaveBeenCalled();
    expect(mock.call).not.toHaveBeenCalled();
    const options = mock.transport.mock.calls[0][1];
    expect(options.requestInit.headers).toMatchObject({
      Authorization: `Bearer ${readToken}`,
      "X-Hindsight-Project-Bank": "YWxwaGE",
      "X-Hindsight-Harness": "codex",
    });
  });
  it("returns original catalog and uses write identity only for discovery", async () => {
    const catalog = await fetchRemoteCatalog("codex", loadConfig({ harness: "codex" }));
    expect(catalog.tools[0].description).toBe("NAS description");
    expect(mock.call).not.toHaveBeenCalled();
    expect(mock.transport.mock.calls[0][1].requestInit.headers.Authorization).toBe(
      `Bearer ${writeToken}`
    );
  });
  it("fails unmapped projects without network", async () => {
    mappings("beta");
    await expect(
      callRemoteTool("codex", root, "normal", "hindsight_recall", { query: "x" })
    ).rejects.toThrow("credential_missing");
    expect(mock.connect).not.toHaveBeenCalled();
  });
  it.each(["plan", "unknown"] as const)("rejects %s writes before networking", async (mode) => {
    await expect(
      callRemoteTool("codex", root, mode, "hindsight_save_conclusion", {
        content: "x",
        evidence: "y",
      })
    ).rejects.toThrow("permission_denied");
    expect(mock.connect).not.toHaveBeenCalled();
  });
  it("rejects target and trusted-context overrides", async () => {
    for (const key of ["bank_id", "cwd", "endpoint", "token", "_context"])
      await expect(
        callRemoteTool("codex", root, "normal", "hindsight_recall", { [key]: "x" })
      ).rejects.toThrow("override");
    expect(mock.connect).not.toHaveBeenCalled();
  });
  it("selects token per operation and passes cancellation options as third argument", async () => {
    await callRemoteTool("codex", root, "normal", "hindsight_recall", { query: "x" });
    await callRemoteTool("codex", root, "normal", "hindsight_save_conclusion", {
      content: "x",
      evidence: "y",
    });
    expect(mock.transport.mock.calls.map((c) => c[1].requestInit.headers.Authorization)).toEqual([
      `Bearer ${readToken}`,
      `Bearer ${writeToken}`,
    ]);
    expect(mock.call.mock.calls[0][2].signal).toBeInstanceOf(AbortSignal);
  });
  it.each(["plan", "unknown"] as const)(
    "%s status reads use submitting identity without permitting writes",
    async (mode) => {
      await callRemoteTool("codex", root, mode, "hindsight_sync_status", {});
      await callRemoteTool("codex", root, mode, "hindsight_recall", { query: "x" });
      expect(
        mock.transport.mock.calls.map((call) => call[1].requestInit.headers.Authorization)
      ).toEqual([`Bearer ${writeToken}`, `Bearer ${readToken}`]);
      mock.connect.mockClear();
      mock.transport.mockClear();
      for (const name of ["hindsight_save_conclusion", "hindsight_ingest_document"])
        await expect(
          callRemoteTool("codex", root, mode, name, { content: "x", evidence: "y" })
        ).rejects.toThrow("permission_denied");
      expect(mock.connect).not.toHaveBeenCalled();
    }
  );
  it("status reads use reader identity when no write credential exists", async () => {
    writeFileSync(
      secrets,
      JSON.stringify({
        endpoint: "https://nas.example/mcp",
        projects: { codex: { alpha: { readToken } } },
      })
    );
    await callRemoteTool("codex", root, "plan", "hindsight_sync_status", {});
    expect(mock.transport.mock.calls[0][1].requestInit.headers.Authorization).toBe(
      `Bearer ${readToken}`
    );
  });
  it("does not retry status with reader token after writer authentication fails", async () => {
    mock.connect.mockRejectedValue(new Error("unauthorized"));
    await expect(
      callRemoteTool("codex", root, "plan", "hindsight_sync_status", {})
    ).rejects.toThrow("unauthorized");
    expect(mock.connect).toHaveBeenCalledTimes(1);
    expect(mock.transport.mock.calls[0][1].requestInit.headers.Authorization).toBe(
      `Bearer ${writeToken}`
    );
  });
  it("rejects result when mapping changes during call", async () => {
    mock.call.mockImplementation(async () => {
      mappings("beta");
      return { content: [{ type: "text", text: "OLD DATA" }] };
    });
    await expect(
      callRemoteTool("codex", root, "normal", "hindsight_recall", { query: "x" })
    ).rejects.toThrow();
    expect(mock.call).toHaveBeenCalledTimes(1);
  });
  it("unregistered and disabled rules never connect", async () => {
    writeFileSync(registry, JSON.stringify({ projects: [] }));
    expect(await fetchRemoteRules("codex", root)).toBeNull();
    writeFileSync(
      registry,
      JSON.stringify({ projects: [{ root, bankId: "alpha", enabled: false }] })
    );
    expect(await fetchRemoteRules("codex", root)).toBeNull();
    expect(mock.connect).not.toHaveBeenCalled();
  });
  it.each(["mapping", "credential"])(
    "rejects %s changes during initialize before business call",
    async (changed) => {
      mock.connect.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (changed === "mapping") mappings("beta");
        else
          writeFileSync(
            secrets,
            JSON.stringify({
              endpoint: "https://nas.example/mcp",
              projects: { codex: { alpha: { readToken: readToken + "rotated", writeToken } } },
            })
          );
      });
      await expect(
        callRemoteTool("codex", root, "normal", "hindsight_recall", { query: "x" })
      ).rejects.toThrow();
      expect(mock.call).not.toHaveBeenCalled();
    }
  );
  it("catalog header exists only for metadata discovery", async () => {
    await fetchRemoteCatalog("codex", loadConfig({ harness: "codex" }));
    await fetchRemoteRules("codex", root);
    await callRemoteTool("codex", root, "normal", "hindsight_recall", { query: "x" });
    expect(
      mock.transport.mock.calls.map((call) => call[1].requestInit.headers["X-Hindsight-Catalog"])
    ).toEqual(["1", undefined, undefined]);
  });
  it("rejects old credential results after rotation without retry", async () => {
    mock.call.mockImplementation(async () => {
      writeFileSync(
        secrets,
        JSON.stringify({
          endpoint: "https://nas.example/mcp",
          projects: { codex: { alpha: { readToken: readToken + "rotated" } } },
        })
      );
      return { content: [{ type: "text", text: "OLD DATA" }] };
    });
    await expect(
      callRemoteTool("codex", root, "normal", "hindsight_recall", { query: "x" })
    ).rejects.toThrow("binding_changed");
    expect(mock.call).toHaveBeenCalledTimes(1);
  });
  it("aborts a running request when mapping changes", async () => {
    mock.call.mockImplementation(
      (_args, _schema, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(options.signal.reason));
          setTimeout(() => mappings("beta"), 20);
        })
    );
    await expect(
      callRemoteTool("codex", root, "normal", "hindsight_recall", { query: "x" })
    ).rejects.toThrow("binding_changed");
    expect(mock.call).toHaveBeenCalledTimes(1);
  });
  it("rejects credential file broad permissions without network", async () => {
    chmodSync(secrets, 0o644);
    await expect(fetchRemoteRules("codex", root)).rejects.toThrow("config_invalid");
    expect(mock.connect).not.toHaveBeenCalled();
  });
  it("document import uses write credential and rejects plan mode", async () => {
    await expect(
      callRemoteTool("codex", root, "plan", "hindsight_ingest_document", { content: "document" })
    ).rejects.toThrow("permission_denied");
    expect(mock.connect).not.toHaveBeenCalled();
    await callRemoteTool("codex", root, "normal", "hindsight_ingest_document", {
      content: "document",
    });
    expect(mock.transport.mock.calls[0][1].requestInit.headers.Authorization).toBe(
      `Bearer ${writeToken}`
    );
  });
  it("rejects incoherent tool annotations", async () => {
    mock.list.mockResolvedValue({
      tools: [
        {
          name: "hindsight_save_conclusion",
          annotations: { readOnlyHint: true },
          inputSchema: { type: "object" },
        },
      ],
    });
    await expect(fetchRemoteCatalog("codex", loadConfig({ harness: "codex" }))).rejects.toThrow(
      "catalog_invalid"
    );
  });
  it("invalid NAS connection setting cannot silently fall back to REST", () => {
    expect(() => resolveConfig({ remoteMcpConfigFile: "" })).toThrow("path_invalid");
    expect(() => resolveConfig({ remoteMcpConfigFile: "relative.json" })).toThrow("path_invalid");
  });
  it("cannot override connection file from bank or path config", () => {
    const cfg = resolveConfig({
      remoteMcpConfigFile: secrets,
      banks: { alpha: { remoteMcpConfigFile: "/evil" } as never },
      paths: { [root]: { remoteMcpConfigFile: "/evil2" } as never },
    });
    expect(applyBankConfig(cfg, "alpha", root).cfg.remoteMcpConfigFile).toBe(secrets);
  });
});
