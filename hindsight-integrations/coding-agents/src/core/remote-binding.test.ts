import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HindsightClient, type RemoteBinding } from "./hindsight";
import { buildKnowledgeTools } from "./knowledge-tools";
import {
  conclusionStatus,
  pendingConclusionWorkspaces,
  pendingRemoteConclusions,
  retryConclusions,
  saveConclusion,
} from "./conclusions";

let temp: string;
let calls: { url: string; method: string; body?: unknown }[];
let offline: boolean, complete: boolean, exists: boolean;
let originalBank: string;
const evidence = { content: "Verified durable conclusion", evidence: "Fixture source commit abc" };
function binding(principalId = "alice"): RemoteBinding {
  return {
    principalId,
    policyRevision: "policy1",
    credentialId: `${principalId}-key`,
    assertRead: vi.fn(),
    assertWrite: vi.fn(),
  };
}
function client(remoteBinding = binding(), apiUrl = "http://fixture.local") {
  return new HindsightClient({
    apiUrl,
    bank: "p-fixture",
    apiToken: "backend-key",
    remoteBinding,
    dedupScopeId: "backend-fixture",
  });
}
beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), "hs-remote-binding-"));
  vi.stubEnv("HINDSIGHT_SHARED_STATE_DIR", temp);
  calls = [];
  offline = false;
  complete = false;
  exists = true;
  originalBank = "p-fixture";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const method = init.method ?? "GET";
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });
      if (offline) return Response.json({ error: "offline" }, { status: 503 });
      if (url.endsWith("/stats"))
        return Response.json({ bank_id: "p-fixture" }, { status: exists ? 200 : 404 });
      if (url.endsWith("/version")) return Response.json({ api_version: "0.10.1" });
      if (url.endsWith("/config"))
        return Response.json({
          config: {
            retain_strategies: {
              project_conclusions_v1: {
                retain_extraction_mode: "concise",
                retain_mission: "Preserve durable facts",
              },
            },
          },
        });
      if (url.endsWith("/memories"))
        return Response.json({ operation_id: (body as Record<string, unknown>).operation_id });
      if (url.includes("/chunks/"))
        return Response.json({
          bank_id: originalBank,
          chunk_id: "chunk-fixture",
          chunk_text: "Original evidence",
        });
      if (url.endsWith("/memories/memory-fixture"))
        return Response.json({
          id: "memory-fixture",
          text: "Fact evidence",
          chunk_id: "chunk-fixture",
        });
      if (url.includes("/operations/"))
        return Response.json({ status: complete ? "completed" : "processing" });
      return Response.json({ results: [] });
    })
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(temp, { recursive: true, force: true });
});
describe("authenticated remote bindings", () => {
  it("checks reads and bank existence and denies arbitrary backend URLs", async () => {
    const b = binding(),
      c = client(b);
    await c.req("POST", c.bankUrl("/memories/recall"), { query: "fact" });
    expect(b.assertRead).toHaveBeenCalled();
    expect(b.assertWrite).not.toHaveBeenCalled();
    expect(calls[0].url).toBe(c.bankUrl("/stats"));
    await expect(c.req("GET", "http://other.local/private")).rejects.toThrow(
      "remote_scope_changed"
    );
    exists = false;
    await expect(c.listPages()).rejects.toThrow("project_bank_missing");
  });
  it("reads originals through the global chunk endpoint only for the bound bank", async () => {
    const c = client();
    expect((await c.readMemory("memory-fixture", true)).original?.chunk_text).toBe(
      "Original evidence"
    );
    originalBank = "another-project";
    await expect(c.readMemory("memory-fixture", true)).rejects.toThrow("project_bank_mismatch");
    await expect(c.req("POST", `${c.apiUrl}/v1/default/chunks/chunk-fixture`, {})).rejects.toThrow(
      "remote_scope_changed"
    );
  });
  it("denies writes under read-only, unknown and plan permissions", async () => {
    const b = binding();
    b.assertWrite = () => {
      throw new Error("remote_write_denied");
    };
    const c = client(b);
    await expect(c.req("POST", c.bankUrl("/memories"), {})).rejects.toThrow("remote_write_denied");
    const tool = buildKnowledgeTools(client(), "p-fixture").find(
      (t) => t.name === "hindsight_save_conclusion"
    )!;
    for (const permission of ["plan", "unknown"] as const)
      expect((await tool.handler(evidence, { permission })).isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
  it("rejects role revocation after a read before returning evidence", async () => {
    const b = binding();
    let count = 0;
    b.assertRead = () => {
      if (++count > 3) throw new Error("remote_policy_changed");
    };
    const c = client(b);
    await expect(c.listPages()).rejects.toThrow("remote_policy_changed");
  });
  it("requires evidence and does not create or configure a bank", async () => {
    const c = client();
    await expect(saveConclusion(c, { content: "missing evidence" }, "remote")).rejects.toThrow();
    await expect(c.configureBank()).rejects.toThrow("remote_bank_management_denied");
    expect(calls).toHaveLength(0);
  });
  it("deduplicates principals without delivering or corrupting the original pending task", async () => {
    offline = true;
    const a = await saveConclusion(client(), evidence, "remote");
    expect(a.state).toBe("pending");
    const before = calls.length;
    const b = await saveConclusion(client(binding("bob")), evidence, "remote");
    expect(b).toMatchObject({ id: a.id, state: "pending", deduplicated: true });
    expect(calls).toHaveLength(before);
    expect(pendingConclusionWorkspaces()).toEqual([]);
    expect(pendingRemoteConclusions()).toEqual([
      {
        bank: "p-fixture",
        endpoint: "http://fixture.local",
        principalId: "alice",
        policyRevision: "policy1",
        credentialId: "alice-key",
      },
    ]);
    offline = false;
    complete = true;
    await retryConclusions(client());
    expect(pendingRemoteConclusions()).toEqual([]);
    expect((await saveConclusion(client(binding("bob")), evidence, "remote")).state).toBe(
      "completed"
    );
    expect(calls.filter((c) => c.method === "POST" && c.url.endsWith("/memories"))).toHaveLength(1);
  });
  it("shares operation ids across backend aliases and preserves asynchronous receipts", async () => {
    const a = await saveConclusion(client(), evidence, "codex");
    expect(a.state).toBe("submitted");
    const b = await saveConclusion(client(binding("bob"), "http://nas.local"), evidence, "remote");
    expect(b).toMatchObject({ id: a.id, state: "submitted", deduplicated: true });
    expect(calls.filter((c) => c.method === "POST" && c.url.endsWith("/memories"))).toHaveLength(1);
  });
  it("isolates principal status and preserves the original backend credential scope", async () => {
    const a = client();
    await saveConclusion(a, evidence, "remote");
    expect(conclusionStatus(a)).toEqual([{ state: "submitted", count: 1 }]);
    expect(conclusionStatus(client(binding("bob")))).toEqual([]);
    const changed = new HindsightClient({
      apiUrl: a.apiUrl,
      bank: a.bank,
      apiToken: "different-tenant",
      remoteBinding: binding(),
      dedupScopeId: a.dedupScopeId,
    });
    const before = calls.length;
    await retryConclusions(changed);
    expect(calls).toHaveLength(before);
    expect(conclusionStatus(a)).toEqual([{ state: "failed", count: 1 }]);
  });
  it("quarantines revoked original authorization without resubmitting", async () => {
    const b = binding(),
      c = client(b);
    offline = true;
    await saveConclusion(c, evidence, "remote");
    offline = false;
    b.assertWrite = () => {
      throw new Error("remote_policy_changed");
    };
    const revoked = client(b),
      before = calls.length;
    await retryConclusions(revoked);
    expect(calls).toHaveLength(before);
    expect(pendingRemoteConclusions()).toEqual([]);
  });
});
