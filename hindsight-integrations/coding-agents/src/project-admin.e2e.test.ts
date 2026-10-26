import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dirs: string[] = [];
const servers: Server[] = [];
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const read = (file: string) => JSON.parse(readFileSync(file, "utf8"));
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "project-admin-e2e-"));
  dirs.push(root);
  const directory = join(root, "project");
  mkdirSync(directory);
  const registry = join(root, "registry.json");
  const privateConfig = join(root, "private.json");
  const serverConfig = join(root, "server.json");
  const state = {
    bank: undefined as undefined | { bank_id: string; name: string },
    config: { retain_strategies: { custom: { retain_mission: "preserve custom" } } } as any,
    requests: [] as { method: string; path: string; body: any }[],
    page: undefined as any,
  };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    const path = new URL(req.url!, "http://localhost").pathname;
    const method = req.method!;
    state.requests.push({ method, path, body });
    res.setHeader("Content-Type", "application/json");
    const respond = (data: unknown) => res.end(JSON.stringify(data));
    if (method === "GET" && path === "/v1/default/banks")
      return respond({ banks: state.bank ? [state.bank] : [], total: state.bank ? 1 : 0 });
    if (method === "PUT" && path === "/v1/default/banks/p-test-cli") {
      state.bank = { bank_id: "p-test-cli", name: body.name };
      return respond({});
    }
    if (path === "/v1/default/banks/p-test-cli/config") {
      if (method === "PATCH") state.config = { ...state.config, ...body.updates };
      return respond({ config: state.config });
    }
    if (method === "GET" && path.endsWith("/knowledge-base/tree"))
      return respond({
        roots: state.page
          ? [{ id: "page-1", kind: "page", name: state.page.name, mental_model_id: "model-1" }]
          : [],
      });
    if (method === "POST" && path.endsWith("/knowledge-base/pages")) {
      state.page = body;
      return respond({
        page_id: "page-1",
        mental_model_id: "model-1",
        operation_id: "operation-1",
      });
    }
    if (method === "GET" && path.endsWith("/knowledge-base/pages/page-1"))
      return respond({
        name: state.page.name,
        description: state.page.source_query,
        tags: state.page.tags,
      });
    if (method === "GET" && path.endsWith("/mental-models/model-1"))
      return respond({
        source_query: state.page.source_query,
        tags: state.page.tags,
        max_tokens: state.page.max_tokens,
        trigger: state.page.trigger,
      });
    res.statusCode = 404;
    return respond({});
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const addr = server.address() as { port: number };
  writeFileSync(
    serverConfig,
    JSON.stringify({
      apiUrl: `http://127.0.0.1:${addr.port}`,
      apiToken: "SYNTHETIC_BACKEND_SECRET",
      publicOrigin: "https://example.test",
      clients: [
        {
          id: "existing-admin",
          tokenHash: hash("SYNTHETIC_LIBRARY_TOKEN"),
          mode: "library",
          allowedBanks: "*",
          read: true,
          write: false,
        },
      ],
    }),
    { mode: 0o600 }
  );
  const common = [
    "--directory",
    directory,
    "--bank-id",
    "p-test-cli",
    "--name",
    "测试模型项目",
    "--registry",
    registry,
    "--private-config",
    privateConfig,
    "--endpoint",
    "https://example.test/mcp",
    "--server-config",
    serverConfig,
  ];
  async function run(args: string[], extraEnv: Record<string, string> = {}) {
    return new Promise<{ code: number; stdout: string; value: any }>((done, reject) => {
      execFile(
        process.execPath,
        [resolve("dist/project-admin.js"), ...args],
        {
          timeout: 20000,
          env: {
            ...process.env,
            HOME: root,
            HINDSIGHT_CONFIG: join(root, "absent.json"),
            ...extraEnv,
          },
        },
        (error, stdout, stderr) => {
          try {
            expect(stderr).not.toContain("SYNTHETIC_BACKEND_SECRET");
            done({
              code: error ? Number((error as any).code) : 0,
              stdout,
              value: JSON.parse(stdout),
            });
          } catch (e) {
            reject(e);
          }
        }
      );
    });
  }
  const writes = () => state.requests.filter((r) => r.method !== "GET");
  return { root, directory, registry, privateConfig, serverConfig, state, common, run, writes };
}

function fakeSsh(root: string, response: string): Record<string, string> {
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "ssh"),
    `#!${process.execPath}\nlet input = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", chunk => input += chunk); process.stdin.on("end", () => { const request = JSON.parse(input); ${response} });\n`,
    { mode: 0o700 }
  );
  return { PATH: bin + ":" + process.env.PATH };
}

describe("built project-admin CLI (isolated mock backend, no LLM)", () => {
  it("initializes all bindings with Chinese names, preserves tokens on rerun, and doctor is read-only", async () => {
    const f = await fixture();
    const init = await f.run(["init", ...f.common]);
    expect(init.code).toBe(0);
    expect(init.value.ready).toBe(true);
    expect(Object.values(init.value.checks).every(Boolean)).toBe(true);
    expect(init.value.mental_models).toBe("pending_user_approval");
    expect(read(f.registry).projects).toEqual([
      { root: f.directory, bankId: "p-test-cli", name: "测试模型项目", enabled: true },
    ]);
    expect(f.state.bank?.name).toBe("测试模型项目");
    expect(f.state.config.retain_strategies.custom.retain_mission).toBe("preserve custom");
    expect(f.state.config.retain_strategies.project_conclusions_v1.retain_extraction_mode).toBe(
      "concise"
    );
    const creds = read(f.privateConfig).projects.codex["p-test-cli"];
    expect(statSync(f.privateConfig).mode & 0o777).toBe(0o600);
    const remote = read(f.serverConfig);
    expect(remote.clients).toHaveLength(3);
    for (const [role, token] of Object.entries(creds)) {
      const identity = remote.clients.find((c: any) => c.tokenHash === hash(token as string));
      expect(identity).toMatchObject({
        mode: "project",
        bankId: "p-test-cli",
        harness: "codex",
        requireProjectBinding: true,
        read: true,
        write: role === "writeToken",
      });
      expect(init.stdout).not.toContain(token);
      expect(readFileSync(f.serverConfig, "utf8")).not.toContain(token);
    }
    const snapshots = [f.registry, f.privateConfig, f.serverConfig].map((p) =>
      readFileSync(p, "utf8")
    );
    const writes = f.writes().length;
    const again = await f.run(["init", ...f.common]);
    expect(again.code).toBe(0);
    expect(f.writes()).toHaveLength(writes);
    expect(
      [f.registry, f.privateConfig, f.serverConfig].map((p) => readFileSync(p, "utf8"))
    ).toEqual(snapshots);
    const doctor = await f.run(["doctor", ...f.common]);
    expect(doctor.code).toBe(0);
    expect(doctor.value.ready).toBe(true);
    expect(f.writes()).toHaveLength(writes);
    expect(
      [f.registry, f.privateConfig, f.serverConfig].map((p) => readFileSync(p, "utf8"))
    ).toEqual(snapshots);
    for (const token of Object.values(creds)) expect(doctor.stdout).not.toContain(token);
  }, 30000);

  it("requires reviewed plan hash, creates one manual page, skips exact reruns, and rejects changed sources", async () => {
    const f = await fixture();
    expect((await f.run(["init", ...f.common])).code).toBe(0);
    const source = "# 模型训练\n本目录验证训练数据与微调效果。\n";
    writeFileSync(join(f.directory, "README.md"), source);
    const planFile = join(f.root, "plan.json");
    const scope = "训练数据与微调效果";
    const model = {
      name: "训练与评估",
      source_query: `整理测试模型项目的${scope}`,
      scope,
      tags: ["topic:训练"],
      tags_match: "all",
      fact_types: ["world", "experience", "observation"],
      refresh: "manual",
      max_tokens: 2048,
      source_refs: ["README.md"],
    };
    const raw = JSON.stringify({
      version: 1,
      project: {
        directory: f.directory,
        bank_id: "p-test-cli",
        display_name: "测试模型项目",
        purpose: "训练验证",
      },
      sources: [{ path: "README.md", sha256: hash(source) }],
      models: [model],
    });
    writeFileSync(planFile, raw);
    const before = f.writes().length;
    const preview = await f.run(["models-preview", "--plan", planFile]);
    expect(preview.code).toBe(0);
    expect(preview.value.status).toBe("pending_user_approval");
    expect(preview.value.sha256).toBe(hash(raw));
    const args = ["--plan", planFile, "--registry", f.registry, "--server-config", f.serverConfig];
    for (const approval of [[], ["--approve", "0".repeat(64)]]) {
      const rejected = await f.run(["models-apply", ...args, ...approval]);
      expect(rejected.code).toBe(1);
      expect(rejected.value).toEqual({
        error: "project_model_approval_required",
        stage: "user_approval",
      });
    }
    expect(f.writes()).toHaveLength(before);
    // This synthetic fixture represents a reviewed draft approval, not production human authorization.
    const approved = ["models-apply", ...args, "--approve", hash(raw)];
    const applied = await f.run(approved);
    expect(applied.code).toBe(0);
    expect(applied.value.pages).toEqual([
      expect.objectContaining({ status: "created", page_id: "page-1", generation: "pending" }),
    ]);
    expect(f.state.page.trigger).toEqual({
      refresh_after_consolidation: false,
      refresh_cron: null,
      fact_types: model.fact_types,
      tags_match: "all",
      tag_groups: null,
    });
    expect(f.state.page.source_query).toContain(scope);
    expect(f.state.page.source_query).toContain("测试模型项目");
    const repeated = await f.run(approved);
    expect(repeated.code).toBe(0);
    expect(repeated.value.pages[0].status).toBe("skipped");
    expect(f.state.requests.filter((r) => r.method === "POST")).toHaveLength(1);
    writeFileSync(join(f.directory, "README.md"), source + "changed");
    const changed = await f.run(approved);
    expect(changed.code).toBe(1);
    expect(changed.value).toEqual({ error: "model_plan_sources_changed", stage: "model_plan" });
    expect(f.state.requests.filter((r) => r.method === "POST")).toHaveLength(1);
  }, 30000);

  it("rejects an English-only name before any remote write", async () => {
    const f = await fixture();
    const args = [...f.common];
    args[args.indexOf("--name") + 1] = "plain-project";
    const result = await f.run(["init", ...args]);
    expect(result.code).toBe(1);
    expect(result.value).toEqual({ error: "project_chinese_name_required", stage: "name" });
    expect(f.state.requests).toHaveLength(0);
  });
  it("preserves remote doctor failed checks returned by a fake SSH process exiting 1", async () => {
    const f = await fixture();
    expect((await f.run(["init", ...f.common])).code).toBe(0);
    const snapshots = [f.registry, f.privateConfig, f.serverConfig].map((p) =>
      readFileSync(p, "utf8")
    );
    const before = f.state.requests.length;
    const env = fakeSsh(
      f.root,
      `process.stdout.write(JSON.stringify({ ready: false, checks: { bank: false, name: false, strategy: false, identities: true }, request })); process.exitCode = 1;`
    );
    const result = await f.run(
      [
        "doctor",
        ...f.common,
        "--ssh-host",
        "synthetic-host",
        "--remote-cli",
        "/synthetic/project-admin.js",
      ],
      env
    );
    expect(result.code).toBe(1);
    expect(result.value).toMatchObject({
      ready: false,
      checks: {
        local_registry: true,
        local_credentials: true,
        local_name: true,
        remote_bank: false,
        remote_name: false,
        remote_strategy: false,
        remote_identities: true,
      },
    });
    expect(result.value.error).toBeUndefined();
    expect(f.state.requests).toHaveLength(before);
    expect(
      [f.registry, f.privateConfig, f.serverConfig].map((p) => readFileSync(p, "utf8"))
    ).toEqual(snapshots);
    for (const token of Object.values(read(f.privateConfig).projects.codex["p-test-cli"]))
      expect(result.stdout).not.toContain(token);
  }, 30000);

  it("preserves successful page receipts in partial model results returned by fake SSH exiting 1", async () => {
    const f = await fixture();
    expect((await f.run(["init", ...f.common])).code).toBe(0);
    const source = "项目用于训练数据校验。";
    writeFileSync(join(f.directory, "README.md"), source);
    const planFile = join(f.root, "plan.json");
    const raw = JSON.stringify({
      version: 1,
      project: {
        directory: f.directory,
        bank_id: "p-test-cli",
        display_name: "测试模型项目",
        purpose: "训练验证",
      },
      sources: [{ path: "README.md", sha256: hash(source) }],
      models: [
        {
          name: "训练模型",
          source_query: "测试模型项目训练数据校验",
          scope: "训练数据校验",
          tags: [],
          tags_match: "all",
          fact_types: ["world"],
          refresh: "manual",
          max_tokens: 2048,
          source_refs: ["README.md"],
        },
      ],
    });
    writeFileSync(planFile, raw);
    const page = {
      name: "训练模型",
      status: "created",
      page_id: "synthetic-page",
      mental_model_id: "synthetic-model",
      operation_id: "synthetic-operation",
      generation: "pending",
    };
    const env = fakeSsh(
      f.root,
      `process.stdout.write(JSON.stringify({ ok: false, code: "creation_status_unknown", approved_sha256: request.approvedHash, pages: [${JSON.stringify(page)}] })); process.exitCode = 1;`
    );
    const before = f.state.requests.length;
    const result = await f.run(
      [
        "models-apply",
        "--plan",
        planFile,
        "--approve",
        hash(raw),
        "--registry",
        f.registry,
        "--server-config",
        f.serverConfig,
        "--ssh-host",
        "synthetic-host",
        "--remote-cli",
        "/synthetic/project-admin.js",
      ],
      env
    );
    expect(result.code).toBe(1);
    expect(result.value).toEqual({
      ok: false,
      code: "creation_status_unknown",
      approved_sha256: hash(raw),
      pages: [page],
    });
    expect(f.state.requests).toHaveLength(before);
  }, 30000);
  it("rejects invalid exit-zero SSH JSON without exposing its raw secret payload", async () => {
    const f = await fixture();
    expect((await f.run(["init", ...f.common])).code).toBe(0);
    const source = "项目用于训练验证。";
    writeFileSync(join(f.directory, "README.md"), source);
    const planFile = join(f.root, "plan.json");
    const raw = JSON.stringify({
      version: 1,
      project: {
        directory: f.directory,
        bank_id: "p-test-cli",
        display_name: "测试模型项目",
        purpose: "训练验证",
      },
      sources: [{ path: "README.md", sha256: hash(source) }],
      models: [],
    });
    writeFileSync(planFile, raw);
    const env = fakeSsh(
      f.root,
      `process.stdout.write(JSON.stringify({ token: "TEST_SECRET" })); process.exitCode = 0;`
    );
    const before = f.state.requests.length;
    const result = await f.run(
      [
        "models-apply",
        "--plan",
        planFile,
        "--approve",
        hash(raw),
        "--registry",
        f.registry,
        "--server-config",
        f.serverConfig,
        "--ssh-host",
        "synthetic-host",
        "--remote-cli",
        "/synthetic/project-admin.js",
      ],
      env
    );
    expect(result.code).toBe(1);
    expect(result.value).toEqual({
      error: "project_admin_response_invalid",
      stage: "administrator_connection",
    });
    expect(result.stdout).not.toContain("TEST_SECRET");
    expect(result.stdout).not.toContain('"token"');
    expect(f.state.requests).toHaveLength(before);
  }, 30000);
});
