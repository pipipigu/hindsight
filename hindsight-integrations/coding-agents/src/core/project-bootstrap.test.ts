import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { resolveRegisteredProject } from "./project-registry";
import { createServer, type Server } from "node:http";
import {
  completeLocalProject,
  doctorLocalProject,
  existingLocalProjectRequest,
  prepareLocalProject,
  ProjectBootstrapError,
  runRemoteProject,
  type LocalProjectOptions,
} from "./project-bootstrap";
const dirs: string[] = [],
  servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture(): LocalProjectOptions {
  const dir = mkdtempSync(join(tmpdir(), "bootstrap-"));
  dirs.push(dir);
  return {
    directory: dir,
    bankId: "p-test",
    name: "测试项目",
    harness: "codex",
    registryFile: join(dir, "registry.json"),
    privateConfigFile: join(dir, "private.json"),
    endpoint: "https://example.com/mcp",
  };
}
function json(file: string, body: unknown) {
  writeFileSync(file, JSON.stringify(body), { mode: 0o600 });
}
async function backend(o: LocalProjectOptions, seed?: { name: string; config?: any }) {
  const state = {
    bank: seed ? { bank_id: o.bankId, name: seed.name } : (undefined as any),
    config: seed?.config ?? { retain_strategies: { other: { retain_mission: "other" } } },
    writes: 0,
    calls: 0,
    failConfig: false,
    redirect: false,
    onCall: undefined as undefined | (() => void),
  };
  const server = createServer(async (req, res) => {
    state.calls++;
    state.onCall?.();
    if (state.redirect) {
      res.statusCode = 302;
      res.setHeader("Location", "http://127.0.0.1:1/secret");
      return res.end();
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && req.url?.startsWith("/v1/default/banks?"))
      return res.end(
        JSON.stringify({ banks: state.bank ? [state.bank] : [], total: state.bank ? 1 : 0 })
      );
    if (req.method === "PUT") {
      state.writes++;
      state.bank = { bank_id: o.bankId, name: body.name };
      return res.end("{}");
    }
    if (req.method === "PATCH" && req.url?.endsWith("/config")) {
      if (state.failConfig) {
        res.statusCode = 500;
        return res.end(JSON.stringify({ secret: "NEVER_EXPOSE_BACKEND_BODY" }));
      }
      state.writes++;
      state.config = { ...state.config, ...body.updates };
      return res.end("{}");
    }
    if (req.method === "PATCH") {
      state.writes++;
      state.bank.name = body.name;
      return res.end("{}");
    }
    if (req.url?.endsWith("/config")) return res.end(JSON.stringify({ config: state.config }));
    res.statusCode = 404;
    res.end("{}");
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const file = join(o.directory, "server.json");
  json(file, {
    apiUrl: `http://127.0.0.1:${(server.address() as any).port}`,
    apiToken: "PRIVATE_BACKEND_TOKEN",
    publicOrigin: "https://example.com",
    maxConcurrentTools: 8,
    maxConcurrentToolsPerClient: 8,
    clients: [
      {
        id: "old",
        mode: "library",
        allowedBanks: ["other"],
        tokenHash: "a".repeat(64),
        read: true,
        write: false,
      },
    ],
  });
  return { state, file };
}
describe("controlled project bootstrap", () => {
  it("existing request and doctor never create staged files", () => {
    const o = fixture();
    expect(existingLocalProjectRequest(o)).toBeUndefined();
    expect(doctorLocalProject(o).ready).toBe(false);
    expect(existsSync(o.registryFile)).toBe(false);
    expect(existsSync(o.privateConfigFile)).toBe(false);
  });
  it("rejects unsafe bridge endpoints before staging", () => {
    const o = fixture();
    for (const endpoint of [
      "http://example.com/mcp",
      "https://example.com/other",
      "https://example.com/mcp?token=secret",
      "https://user:pass@example.com/mcp",
    ]) {
      expect(() => prepareLocalProject({ ...o, endpoint })).toThrow("project_endpoint_invalid");
    }
    expect(prepareLocalProject({ ...o, endpoint: "http://127.0.0.1:8787/mcp" })).toBeDefined();
  });
  it.each(["symlink", "parent-traversal"])(
    "matches an existing canonical root via %s without adding duplicate entries",
    async (kind) => {
      const o = fixture();
      const alias =
        kind === "symlink"
          ? join(o.directory, "alias")
          : `${o.directory}/../${basename(o.directory)}`;
      if (kind === "symlink") symlinkSync(o.directory, alias, "dir");
      json(o.registryFile, { projects: [{ root: alias, bankId: o.bankId, enabled: true }] });
      const b = await backend(o);
      completeLocalProject(o, await runRemoteProject(prepareLocalProject(o), b.file, "init"));
      const registry = JSON.parse(readFileSync(o.registryFile, "utf8"));
      expect(registry.projects).toHaveLength(1);
      expect(registry.projects[0].root).toBe(alias);
      expect(resolveRegisteredProject(o.directory, o.registryFile)).toMatchObject({
        root: o.directory,
        bankId: o.bankId,
        name: o.name,
      });
    }
  );
  it("rejects canonically duplicate registry roots before staging", () => {
    const o = fixture(),
      alias = `${o.directory}/../${basename(o.directory)}`;
    json(o.registryFile, {
      projects: [
        { root: o.directory, bankId: o.bankId, enabled: true },
        { root: alias, bankId: o.bankId, enabled: true },
      ],
    });
    expect(() => prepareLocalProject(o)).toThrow("project_registry_conflict");
    expect(existsSync(o.privateConfigFile)).toBe(false);
  });
  it("requires a Chinese name before any file or network work", async () => {
    const o = fixture();
    o.name = "p-test";
    expect(() => prepareLocalProject(o)).toThrow("project_chinese_name_required");
    await expect(
      runRemoteProject(
        {
          bankId: o.bankId,
          name: o.name,
          harness: o.harness,
          readTokenHash: "b".repeat(64),
          writeTokenHash: "c".repeat(64),
        },
        "does-not-exist",
        "init"
      )
    ).rejects.toMatchObject({ stage: "name" });
    expect(existsSync(o.privateConfigFile)).toBe(false);
  });
  it("stages once, exposes only hashes, and completes only after remote success", async () => {
    const o = fixture(),
      b = await backend(o),
      request = prepareLocalProject(o);
    expect(prepareLocalProject(o)).toEqual(request);
    expect(JSON.stringify(request)).not.toContain(o.directory);
    expect(Object.keys(request)).toEqual([
      "bankId",
      "name",
      "harness",
      "readTokenHash",
      "writeTokenHash",
    ]);
    expect(doctorLocalProject(o).ready).toBe(false);
    const result = await runRemoteProject(request, b.file, "init");
    expect(result.ready).toBe(true);
    expect(completeLocalProject(o, result).ready).toBe(true);
    expect(statSync(o.privateConfigFile).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(o.registryFile, "utf8")).projects[0].name).toBe(o.name);
    const writes = b.state.writes,
      config = readFileSync(b.file, "utf8"),
      repeated = prepareLocalProject(o);
    expect(repeated).toEqual(request);
    expect((await runRemoteProject(repeated, b.file, "init")).ready).toBe(true);
    expect(b.state.writes).toBe(writes);
    expect(readFileSync(b.file, "utf8")).toBe(config);
    const localBefore = [
      readFileSync(o.registryFile, "utf8"),
      readFileSync(o.privateConfigFile, "utf8"),
    ];
    completeLocalProject(o, result);
    expect([
      readFileSync(o.registryFile, "utf8"),
      readFileSync(o.privateConfigFile, "utf8"),
    ]).toEqual(localBefore);
    const remote = JSON.parse(config);
    expect(remote.clients).toHaveLength(3);
    expect(remote.clients[0].id).toBe("old");
    expect(remote.maxConcurrentToolsPerClient).toBe(8);
    expect(b.state.config.retain_strategies.other).toEqual({ retain_mission: "other" });
  });
  it("doctor is read-only and reports each missing remote prerequisite", async () => {
    const o = fixture(),
      b = await backend(o),
      request = prepareLocalProject(o);
    const result = await runRemoteProject(request, b.file, "doctor");
    expect(result).toMatchObject({
      ready: false,
      checks: { bank: false, name: false, strategy: false, identities: false },
    });
    expect(b.state.writes).toBe(0);
    expect(() => completeLocalProject(o, result)).toThrow("project_remote_not_ready");
  });
  it("preserves unrelated registry entries and valid existing tokens", async () => {
    const o = fixture();
    json(o.registryFile, {
      custom: true,
      projects: [{ root: "/other", bankId: "p-other", name: "其他", enabled: true }],
    });
    json(o.privateConfigFile, {
      endpoint: o.endpoint,
      custom: true,
      projects: {
        codex: {
          "p-test": { readToken: "r".repeat(40), writeToken: "w".repeat(40), custom: true },
          other: { readToken: "o".repeat(40) },
        },
      },
    });
    const b = await backend(o),
      request = prepareLocalProject(o),
      result = await runRemoteProject(request, b.file, "init");
    completeLocalProject(o, result);
    const cfg = JSON.parse(readFileSync(o.privateConfigFile, "utf8"));
    expect(cfg.projects.codex["p-test"].readToken).toBe("r".repeat(40));
    expect(cfg.projects.codex.other.readToken).toBe("o".repeat(40));
    expect(cfg.custom).toBe(true);
    expect(JSON.parse(readFileSync(o.registryFile, "utf8")).projects).toHaveLength(2);
  });
  it("rejects directory/name/token conflicts without replacing existing state", async () => {
    const o = fixture();
    json(o.registryFile, { projects: [{ root: o.directory, bankId: "another", enabled: true }] });
    expect(() => prepareLocalProject(o)).toThrow("project_registry_conflict");
    rmSync(o.registryFile);
    const b = await backend(o, { name: "其他名称" }),
      request = prepareLocalProject(o);
    await expect(runRemoteProject(request, b.file, "init")).rejects.toThrow(
      "project_bank_name_conflict"
    );
    expect(b.state.writes).toBe(0);
    b.state.bank.name = o.name;
    const cfg = JSON.parse(readFileSync(b.file, "utf8"));
    cfg.clients.push({
      id: "conflict",
      mode: "project",
      bankId: o.bankId,
      harness: o.harness,
      requireProjectBinding: true,
      tokenHash: "b".repeat(64),
      read: true,
      write: false,
    });
    json(b.file, cfg);
    await expect(runRemoteProject(request, b.file, "init")).rejects.toThrow(
      "project_identity_conflict"
    );
  });
  it("rejects unsafe local credentials permissions", () => {
    const o = fixture();
    json(o.privateConfigFile, {});
    chmodSync(o.privateConfigFile, 0o644);
    expect(() => prepareLocalProject(o)).toThrow("project_config_permissions_invalid");
  });
  it("retains staged credentials after an interrupted remote setup and does not expose backend errors", async () => {
    const o = fixture(),
      b = await backend(o),
      request = prepareLocalProject(o);
    b.state.failConfig = true;
    let failure: any;
    try {
      await runRemoteProject(request, b.file, "init");
    } catch (e) {
      failure = e;
    }
    expect(failure).toBeInstanceOf(ProjectBootstrapError);
    expect(JSON.stringify(failure)).not.toContain("NEVER_EXPOSE");
    expect(failure.message).not.toContain("PRIVATE");
    expect(prepareLocalProject(o)).toEqual(request);
    expect(existsSync(o.registryFile)).toBe(false);
    b.state.failConfig = false;
    completeLocalProject(o, await runRemoteProject(request, b.file, "init"));
    expect(doctorLocalProject(o).ready).toBe(true);
  });
  it("detects concurrent server file mutation before writing backend or identities", async () => {
    const o = fixture(),
      b = await backend(o),
      request = prepareLocalProject(o);
    b.state.onCall = () => {
      b.state.onCall = undefined;
      const cfg = JSON.parse(readFileSync(b.file, "utf8"));
      cfg.port = 9999;
      json(b.file, cfg);
    };
    await expect(runRemoteProject(request, b.file, "init")).rejects.toThrow(
      "project_configuration_changed"
    );
    expect(b.state.writes).toBe(0);
    expect(JSON.parse(readFileSync(b.file, "utf8")).clients).toHaveLength(1);
  });
  it("rejects backend redirects instead of forwarding the admin bearer token", async () => {
    const o = fixture(),
      b = await backend(o);
    b.state.redirect = true;
    await expect(runRemoteProject(prepareLocalProject(o), b.file, "doctor")).rejects.toMatchObject({
      code: "project_backend_unavailable",
      stage: "backend",
    });
    expect(b.state.calls).toBe(1);
  });
  it("preserves compatible customized strategies and fills only a missing display name", async () => {
    const o = fixture(),
      custom = { retain_extraction_mode: "concise", retain_mission: "custom mission" },
      b = await backend(o, {
        name: "",
        config: { retain_strategies: { project_conclusions_v1: custom } },
      });
    const result = await runRemoteProject(prepareLocalProject(o), b.file, "init");
    expect(result.ready).toBe(true);
    expect(b.state.config.retain_strategies.project_conclusions_v1).toEqual(custom);
    expect(b.state.writes).toBe(1);
  });
  it("rejects mutation of existing tokens after staging", () => {
    const o = fixture();
    prepareLocalProject(o);
    json(o.privateConfigFile, {
      endpoint: o.endpoint,
      projects: { codex: { [o.bankId]: { readToken: "different".repeat(8) } } },
    });
    expect(() => prepareLocalProject(o)).toThrow("project_credential_conflict");
  });
  it("does not overwrite an incompatible conclusion strategy", async () => {
    const o = fixture(),
      b = await backend(o, {
        name: o.name,
        config: {
          retain_strategies: {
            project_conclusions_v1: {
              retain_extraction_mode: "verbatim",
              retain_mission: "custom",
            },
          },
        },
      });
    await expect(runRemoteProject(prepareLocalProject(o), b.file, "init")).rejects.toThrow(
      "project_strategy_conflict"
    );
    expect(b.state.writes).toBe(0);
  });
});
