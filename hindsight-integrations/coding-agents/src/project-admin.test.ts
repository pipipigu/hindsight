import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  adminDiagnostic,
  draftContext,
  parseAdminArguments,
  runProjectAdmin,
} from "./project-admin";
import { ModelPlanError } from "./core/project-model-plan";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "project-admin-cli-"));
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});
const hash = (raw: string) => createHash("sha256").update(raw).digest("hex");
function plan() {
  writeFileSync(join(dir, "README.md"), "测试目录用于验证模型草案批准流程。");
  const value = {
    version: 1,
    project: {
      directory: dir,
      bank_id: "p-test",
      display_name: "测试项目",
      purpose: "批准流程测试",
    },
    sources: [{ path: "README.md", sha256: hash(readFileSync(join(dir, "README.md"), "utf8")) }],
    models: [
      {
        name: "项目用途",
        source_query: "仅总结测试项目中已经核实的运行规则；缺证标待确认。",
        scope: "已经核实的运行规则",
        tags: [],
        fact_types: ["world", "experience", "observation"],
        refresh: "manual",
        max_tokens: 2048,
        source_refs: ["README.md"],
      },
    ],
  };
  const file = join(dir, "model-plan.json");
  writeFileSync(file, JSON.stringify(value, null, 2));
  return file;
}
describe("project administrator CLI boundaries", () => {
  it("rejects unknown/duplicate flags and SSH option injection", () => {
    for (const args of [
      ["init", "--unknown", "x"],
      ["init", "--name", "测试", "--name", "另一个"],
      ["doctor", "--ssh-host", "-oProxyCommand=anything"],
      ["doctor", "--ssh-host", "nas; touch /tmp/x"],
    ])
      expect(() => parseAdminArguments(args)).toThrow();
  });
  it("reports only public diagnostics for unknown exceptions and model source errors", () => {
    expect(
      JSON.stringify(adminDiagnostic(new Error("Bearer TOP_SECRET /home/private/.env")))
    ).not.toMatch(/TOP_SECRET|private|Bearer/);
    expect(adminDiagnostic(new ModelPlanError("model_plan_sources_changed"))).toEqual({
      error: "model_plan_sources_changed",
      stage: "model_plan",
    });
  });
  it("bounds draft evidence, redacts common secrets and skips linked files", () => {
    writeFileSync(join(dir, "README.md"), "password=private-value\n" + "说明".repeat(10000));
    symlinkSync(join(dir, "README.md"), join(dir, "AGENTS.md"));
    const result = draftContext(dir);
    expect(result.sources.map((s) => s.path)).toEqual(["README.md"]);
    expect(result.sources[0].excerpt).not.toContain("private-value");
    expect(result.sources[0].excerpt.length).toBeLessThanOrEqual(2500);
  });
  it("uses notebook source cells without disclosing saved cell outputs", () => {
    writeFileSync(
      join(dir, "test.ipynb"),
      JSON.stringify({
        cells: [
          { cell_type: "code", source: ["import torch\n"], outputs: [{ text: "PRIVATE_OUTPUT" }] },
        ],
      })
    );
    const result = draftContext(dir);
    expect(result.sources[0].excerpt).toBe("import torch");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_OUTPUT");
  });
  it("previews the exact draft hash without calling a remote service", async () => {
    const file = plan(),
      fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const result = (await runProjectAdmin(["models-preview", "--plan", file])) as {
      sha256: string;
      status: string;
    };
    expect(result.sha256).toBe(hash(readFileSync(file, "utf8")));
    expect(result.status).toBe("pending_user_approval");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("refuses model application without approval before administrator configuration is read", async () => {
    const file = plan(),
      fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      runProjectAdmin([
        "models-apply",
        "--plan",
        file,
        "--server-config",
        join(dir, "does-not-exist"),
      ])
    ).rejects.toThrow("project_model_approval_required");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("refuses changed source evidence even when a draft hash was approved", async () => {
    const file = plan(),
      approved = hash(readFileSync(file, "utf8")),
      fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    writeFileSync(join(dir, "README.md"), "资料已改变");
    await expect(
      runProjectAdmin([
        "models-apply",
        "--plan",
        file,
        "--approve",
        approved,
        "--server-config",
        join(dir, "none"),
      ])
    ).rejects.toThrow("model_plan_sources_changed");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("doctor combines checks without staging credentials or modifying any configuration", async () => {
    const registry = join(dir, "registry.json"),
      credentials = join(dir, "private.json"),
      server = join(dir, "server.json");
    const readToken = "test-read-" + "a".repeat(40),
      writeToken = "test-write-" + "b".repeat(40);
    writeFileSync(
      registry,
      JSON.stringify({
        projects: [{ root: dir, bankId: "p-test", name: "测试项目", enabled: true }],
      })
    );
    writeFileSync(
      credentials,
      JSON.stringify({
        endpoint: "https://memory.example/mcp",
        projects: { codex: { "p-test": { readToken, writeToken } } },
      })
    );
    chmodSync(credentials, 0o600);
    writeFileSync(
      server,
      JSON.stringify({
        apiUrl: "http://127.0.0.1:8888",
        publicOrigin: "https://memory.example",
        clients: [
          {
            id: "r",
            tokenHash: hash(readToken),
            mode: "project",
            bankId: "p-test",
            harness: "codex",
            requireProjectBinding: true,
            read: true,
            write: false,
          },
          {
            id: "w",
            tokenHash: hash(writeToken),
            mode: "project",
            bankId: "p-test",
            harness: "codex",
            requireProjectBinding: true,
            read: true,
            write: true,
          },
        ],
      })
    );
    chmodSync(server, 0o600);
    const snapshots = [registry, credentials, server].map((f) => readFileSync(f, "utf8"));
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method ?? "GET").toBe("GET");
      return new Response(
        JSON.stringify(
          String(input).includes("/config")
            ? {
                config: {
                  retain_strategies: {
                    project_conclusions_v1: {
                      retain_extraction_mode: "concise",
                      retain_mission: "verified evidence",
                    },
                  },
                },
              }
            : { banks: [{ bank_id: "p-test", name: "测试项目" }], total: 1 }
        )
      );
    });
    vi.stubGlobal("fetch", fetch);
    const result = (await runProjectAdmin([
      "doctor",
      "--directory",
      dir,
      "--bank-id",
      "p-test",
      "--name",
      "测试项目",
      "--registry",
      registry,
      "--private-config",
      credentials,
      "--server-config",
      server,
    ])) as { ready: boolean; checks: Record<string, boolean> };
    expect(result.ready).toBe(true);
    expect(Object.values(result.checks).every(Boolean)).toBe(true);
    expect([registry, credentials, server].map((f) => readFileSync(f, "utf8"))).toEqual(snapshots);
    expect(readdirSync(dir).some((f) => f.includes("pending"))).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/test-read|test-write/);
  });
});
