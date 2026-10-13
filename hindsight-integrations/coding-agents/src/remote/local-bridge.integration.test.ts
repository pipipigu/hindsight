import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import type { RemoteConfig } from "./config";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const json = (r: { content: unknown[]; isError?: boolean }) => {
  expect(r.isError).not.toBe(true);
  return JSON.parse((r.content[0] as { text: string }).text);
};
describe("local adapters through real NAS HTTP transport", () => {
  let root: string, registry: string, privateFile: string, nasFile: string;
  let backend: Server, legacy: Server;
  let running: Awaited<ReturnType<(typeof import("../mcp-http-server"))["startRemoteServer"]>>;
  let bridge: typeof import("../core/remote-mcp-bridge");
  let config: RemoteConfig, cfg: import("../core/config").Config;
  let directories: { root: string; bankId: string; enabled: boolean }[];
  let privateConfig: {
    endpoint: string;
    projects: Record<string, Record<string, { readToken: string; writeToken: string }>>;
  };
  let calls: { url: string; method: string; body: any; authorization?: string }[],
    legacyCalls: number;
  let held: ServerResponse | undefined, heldReady: (() => void) | undefined;
  const persist = () => writeFileSync(nasFile, JSON.stringify(config));
  beforeEach(async () => {
    vi.resetModules();
    root = mkdtempSync(join(tmpdir(), "local-nas-http-"));
    registry = join(root, "projects.json");
    privateFile = join(root, "client.json");
    nasFile = join(root, "nas.json");
    calls = [];
    legacyCalls = 0;
    held = undefined;
    heldReady = undefined;
    vi.stubEnv("HINDSIGHT_CONFIG", join(root, "host.json"));
    vi.stubEnv("HINDSIGHT_SHARED_STATE_DIR", join(root, "nas-state"));
    directories = ["alpha", "beta"].map((bankId) => ({
      root: join(root, bankId),
      bankId,
      enabled: true,
    }));
    for (const p of directories) mkdirSync(p.root);
    writeFileSync(registry, JSON.stringify({ projects: directories }));
    backend = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
      calls.push({
        url: req.url!,
        method: req.method!,
        body,
        authorization: req.headers.authorization,
      });
      const bank = decodeURIComponent(req.url?.match(/\/banks\/([^/?]+)/)?.[1] ?? "");
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/version") res.end(JSON.stringify({ api_version: "0.10.1" }));
      else if (req.url?.startsWith("/v1/default/banks?"))
        res.end(
          JSON.stringify({
            banks: directories.map((p) => ({ bank_id: p.bankId, name: p.bankId })),
            total: 2,
          })
        );
      else if (req.url?.endsWith("/stats")) res.end(JSON.stringify({ bank_id: bank }));
      else if (req.url?.endsWith("/config"))
        res.end(
          JSON.stringify({
            config: {
              retain_strategies: {
                project_conclusions_v1: {
                  retain_extraction_mode: "concise",
                  retain_mission: "keep verified evidence",
                },
              },
            },
          })
        );
      else if (req.url?.endsWith("/memories/recall") && body.query === "held") {
        held = res;
        res.flushHeaders();
        heldReady?.();
      } else if (req.url?.endsWith("/memories/recall"))
        res.end(
          JSON.stringify({
            results: [
              {
                id: "ea277a76-e147-4943-92cf-d4b7bbbb7b8f",
                text: `verified ${bank} fact`,
                type: "world",
              },
            ],
          })
        );
      else if (req.url?.includes("/knowledge-base/pages/"))
        res.end(
          JSON.stringify({
            id: "kp-example",
            name: `${bank} knowledge`,
            body: `verified ${bank} knowledge page`,
          })
        );
      else if (req.method === "POST" && req.url?.endsWith("/memories"))
        res.end(JSON.stringify({ operation_id: body.operation_id }));
      else if (req.url?.includes("/operations/")) res.end(JSON.stringify({ status: "completed" }));
      else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "missing fixture" }));
      }
    });
    legacy = createServer((_req, res) => {
      legacyCalls++;
      res.end("legacy must not be used");
    });
    await Promise.all([
      new Promise<void>((r) => backend.listen(0, "127.0.0.1", r)),
      new Promise<void>((r) => legacy.listen(0, "127.0.0.1", r)),
    ]);
    config = {
      apiUrl: `http://127.0.0.1:${(backend.address() as { port: number }).port}`,
      apiToken: "backend-master-only-on-NAS",
      bindHost: "127.0.0.1",
      port: 0,
      publicOrigin: "http://127.0.0.1",
      toolGuideExtra: "NAS_RULES_V1",
      maxConcurrentTools: 8,
      maxConcurrentToolsPerClient: 2,
      clients: [],
    };
    privateConfig = { endpoint: "", projects: {} };
    for (const harness of ["codex", "dsh"]) {
      privateConfig.projects[harness] = {};
      for (const bank of ["alpha", "beta"]) {
        const tokens = {
          readToken: `${harness}-${bank}-read-credential-with-at-least-32-bytes`,
          writeToken: `${harness}-${bank}-write-credential-with-at-least-32-bytes`,
        };
        privateConfig.projects[harness][bank] = tokens;
        for (const write of [false, true])
          config.clients.push({
            id: `${harness}-${bank}-${write}`,
            tokenHash: hash(write ? tokens.writeToken : tokens.readToken),
            mode: "project",
            bankId: bank,
            harness,
            requireProjectBinding: true,
            read: true,
            write,
          });
      }
    }
    persist();
    running = await (await import("../mcp-http-server")).startRemoteServer(nasFile);
    config.publicOrigin = `http://127.0.0.1:${(running.http.address() as { port: number }).port}`;
    persist();
    privateConfig.endpoint = config.publicOrigin + "/mcp";
    writeFileSync(privateFile, JSON.stringify(privateConfig), { mode: 0o600 });
    writeFileSync(
      join(root, "host.json"),
      JSON.stringify({
        disabled: false,
        bankResolution: "registry",
        projectRegistryFile: registry,
        remoteMcpConfigFile: privateFile,
        apiUrl: `http://127.0.0.1:${(legacy.address() as { port: number }).port}`,
        apiToken: "old-local-master-must-not-be-used",
        toolGuideExtra: "LOCAL_OLD_RULES_MUST_NOT_APPEAR",
      })
    );
    bridge = await import("../core/remote-mcp-bridge");
    cfg = (await import("../core/config")).loadConfig({ harness: "codex" });
  });
  afterEach(async () => {
    held?.end();
    await running?.close();
    await Promise.all([
      new Promise<void>((r) => backend?.close(() => r())),
      new Promise<void>((r) => legacy?.close(() => r())),
    ]);
    expect(legacyCalls).toBe(0);
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });
  it("discovers schemas and fresh NAS rules without retrieving any memories", async () => {
    const catalog = await bridge.fetchRemoteCatalog("codex", cfg);
    expect(catalog.instructions).toContain("NAS_RULES_V1");
    expect(catalog.instructions).toContain("实际项目由可信宿主按每次会话工作区绑定");
    expect(catalog.tools.some((t) => t.name === "hindsight_ingest_document")).toBe(true);
    expect(catalog.tools.every((t) => !("bank_id" in (t.inputSchema.properties ?? {})))).toBe(true);
    expect(await bridge.fetchRemoteRules("codex", directories[1].root)).toContain(
      "固定绑定项目记忆库 beta"
    );
    config.toolGuideExtra = "NAS_RULES_V2";
    persist();
    const rules = await bridge.fetchRemoteRules("codex", directories[0].root);
    expect(rules).toContain("NAS_RULES_V2");
    expect(rules).not.toContain("LOCAL_OLD_RULES");
    expect(calls).toHaveLength(0);
  });
  it("keeps parallel Codex and DSH calls in their project including knowledge pages", async () => {
    const [a, b] = await Promise.all([
      bridge.callRemoteTool("codex", directories[0].root, "unknown", "hindsight_recall", {
        query: "facts",
      }),
      bridge.callRemoteTool("dsh", directories[1].root, "normal", "hindsight_recall", {
        query: "facts",
      }),
    ]);
    expect(json(a).bank_id).toBe("alpha");
    expect(json(b).bank_id).toBe("beta");
    expect(JSON.stringify(a)).toContain("verified alpha fact");
    expect(JSON.stringify(b)).toContain("verified beta fact");
    const page = json(
      await bridge.callRemoteTool(
        "dsh",
        directories[1].root,
        "plan",
        "hindsight_read_knowledge_page",
        { page_id: "kp-example" }
      )
    );
    expect(page.bank_id).toBe("beta");
    expect(JSON.stringify(page)).toContain("verified beta knowledge page");
    expect(calls.every((c) => c.authorization === "Bearer backend-master-only-on-NAS")).toBe(true);
  });
  it("rejects plan, unknown and unmapped calls before I/O and deduplicates authorized saves across clients", async () => {
    for (const mode of ["plan", "unknown"] as const)
      for (const name of ["hindsight_save_conclusion", "hindsight_ingest_document"])
        await expect(
          bridge.callRemoteTool("codex", directories[0].root, mode, name, {
            content: "verified",
            evidence: "fixture",
          })
        ).rejects.toThrow();
    const unmapped = join(root, "unmapped");
    mkdirSync(unmapped);
    expect(await bridge.fetchRemoteRules("codex", unmapped)).toBeNull();
    await expect(
      bridge.callRemoteTool("dsh", unmapped, "normal", "hindsight_recall", { query: "facts" })
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
    const args = {
      content: "Verified long term decision",
      evidence: "Evidence from isolated fixture",
    };
    expect(
      json(
        await bridge.callRemoteTool(
          "codex",
          directories[0].root,
          "normal",
          "hindsight_save_conclusion",
          args
        )
      ).state
    ).toBe("completed");
    expect(
      json(
        await bridge.callRemoteTool(
          "dsh",
          directories[0].root,
          "normal",
          "hindsight_save_conclusion",
          args
        )
      ).state
    ).toBe("completed");
    const retains = calls.filter((c) => c.method === "POST" && c.url.endsWith("/memories"));
    expect(retains).toHaveLength(1);
    expect(retains[0].body.items[0].metadata.harness).toBe("codex");
    const receipt = json(
      await bridge.callRemoteTool("codex", directories[0].root, "plan", "hindsight_sync_status", {})
    );
    expect(receipt.queue).toContainEqual({ state: "completed", count: 1 });
  });
  it("cancels in-flight memory when registry changes without retrying to the new bank", async () => {
    const ready = new Promise<void>((r) => {
      heldReady = r;
    });
    const pending = bridge.callRemoteTool(
      "codex",
      directories[0].root,
      "normal",
      "hindsight_recall",
      { query: "held" }
    );
    const denied = expect(pending).rejects.toThrow();
    await ready;
    writeFileSync(
      registry,
      JSON.stringify({ projects: [{ ...directories[0], bankId: "beta" }, directories[1]] })
    );
    await denied;
    expect(calls.filter((c) => c.url.endsWith("/memories/recall"))).toHaveLength(1);
    expect(calls.some((c) => c.url.includes("/banks/beta/"))).toBe(false);
  });
});
