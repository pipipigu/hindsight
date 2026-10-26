import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { loadRemoteConfig, type RemoteConfig } from "../remote/config";

export interface LocalProjectOptions {
  directory: string;
  bankId: string;
  name: string;
  harness: string;
  registryFile: string;
  privateConfigFile: string;
  endpoint: string;
}
export interface RemoteProjectRequest {
  bankId: string;
  name: string;
  harness: string;
  readTokenHash: string;
  writeTokenHash: string;
}
export interface ProjectChecks {
  ready: boolean;
  checks: Record<string, boolean>;
}
export class ProjectBootstrapError extends Error {
  constructor(
    readonly code: string,
    readonly stage: string
  ) {
    super(code);
  }
}
const fail = (code: string, stage: string): never => {
  throw new ProjectBootstrapError(code, stage);
};
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const strategyName = "project_conclusions_v1";
export const PROJECT_CONCLUSION_STRATEGY = {
  retain_extraction_mode: "concise",
  retain_mission:
    "Preserve evidence-backed durable project conclusions, attribution, conditions, business dates, and the scope of rule changes. Distinguish proposals from implemented facts; do not infer user approval from assistant text.",
};
type Json = Record<string, unknown>;
interface Registry extends Json {
  projects: Array<{ root: string; bankId: string; name?: string; enabled?: boolean }>;
}
interface Credentials extends Json {
  readToken?: string;
  writeToken?: string;
}
interface PrivateConfig extends Json {
  endpoint?: string;
  projects: Record<string, Record<string, Credentials>>;
}
interface BackendJson extends Json {
  banks?: Array<{ bank_id: string; name?: string }>;
  total?: number;
  config?: {
    retain_strategies?: Record<
      string,
      { retain_extraction_mode?: string; retain_mission?: string }
    >;
  };
}

function validate(request: Pick<RemoteProjectRequest, "bankId" | "name" | "harness">): void {
  if (
    !request.name?.trim() ||
    !/[\p{Script=Han}]/u.test(request.name) ||
    request.name === request.bankId ||
    request.name.length > 256
  )
    fail("project_chinese_name_required", "name");
  if (
    !request.bankId?.trim() ||
    request.bankId.length > 256 ||
    ["__proto__", "constructor", "prototype"].includes(request.bankId) ||
    /[\x00-\x1f]/.test(request.bankId)
  )
    fail("project_bank_invalid", "bank");
  if (
    ["__proto__", "constructor", "prototype"].includes(request.harness) ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(request.harness)
  )
    fail("project_harness_invalid", "identities");
}
function snapshot(file: string, secure = false): string | null {
  if (!existsSync(file)) return null;
  const stat = lstatSync(file);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (secure && ((stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.()))
  )
    fail("project_config_permissions_invalid", "local");
  if (stat.size > 1024 * 1024) fail("project_config_too_large", "local");
  return readFileSync(file, "utf8");
}
function parse<T extends object>(raw: string | null, fallback: T, stage: string): T {
  if (raw === null) return fallback;
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw 0;
    return value as T;
  } catch {
    return fail("project_configuration_invalid", stage);
  }
}
/** Cooperating CLI writers lock and verify the file again before atomically replacing it. */
function atomic(file: string, expected: string | null, value: object, remote = false): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.bootstrap-lock`,
    temp = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  let fd: number;
  try {
    fd = openSync(lock, "wx", 0o600);
  } catch {
    return fail("project_configuration_busy", "commit");
  }
  try {
    if (snapshot(file) !== expected) fail("project_configuration_changed", "commit");
    writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    if (remote) {
      try {
        loadRemoteConfig(temp);
      } catch {
        fail("project_server_configuration_invalid", "commit");
      }
    }
    if (snapshot(file) !== expected) fail("project_configuration_changed", "commit");
    renameSync(temp, file);
  } finally {
    closeSync(fd);
    unlinkSync(lock);
    if (existsSync(temp)) unlinkSync(temp);
  }
}
function local(options: LocalProjectOptions) {
  validate(options);
  if (
    !isAbsolute(options.directory) ||
    !existsSync(options.directory) ||
    !lstatSync(options.directory).isDirectory()
  )
    fail("project_directory_missing", "directory");
  const directory = realpathSync(options.directory);
  let endpoint: URL;
  try {
    endpoint = new URL(options.endpoint);
  } catch {
    return fail("project_endpoint_invalid", "credentials");
  }
  if (
    (endpoint.protocol !== "https:" &&
      !(
        endpoint.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)
      )) ||
    endpoint.pathname !== "/mcp" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash ||
    endpoint.search
  )
    fail("project_endpoint_invalid", "credentials");
  const registryRaw = snapshot(options.registryFile),
    privateRaw = snapshot(options.privateConfigFile, true);
  const registry = parse<Registry>(registryRaw, { projects: [] }, "registry"),
    config = parse<PrivateConfig>(
      privateRaw,
      { endpoint: options.endpoint, projects: {} },
      "credentials"
    );
  if (
    !Array.isArray(registry.projects) ||
    (config.projects !== undefined &&
      (!config.projects || typeof config.projects !== "object" || Array.isArray(config.projects)))
  )
    fail("project_configuration_invalid", "local");
  if (config.endpoint && config.endpoint !== options.endpoint)
    fail("project_endpoint_conflict", "credentials");
  if (
    registry.projects.some((p) => !p || typeof p.root !== "string" || typeof p.bankId !== "string")
  )
    fail("project_configuration_invalid", "registry");
  const roots = new Map<string, Registry["projects"][number]>();
  for (const project of registry.projects) {
    if (!isAbsolute(project.root)) fail("project_configuration_invalid", "registry");
    let root: string;
    try {
      root = existsSync(project.root) ? realpathSync.native(project.root) : resolve(project.root);
    } catch {
      return fail("project_configuration_invalid", "registry");
    }
    if (roots.has(root)) fail("project_registry_conflict", "registry");
    roots.set(root, project);
  }
  const exact = [...roots.entries()]
    .filter(([root]) => root === directory)
    .map(([, project]) => project);
  if (exact.length > 1) fail("project_registry_conflict", "registry");
  const mapping = exact[0];
  if (
    mapping &&
    (mapping.bankId !== options.bankId || (mapping.name && mapping.name !== options.name))
  )
    fail("project_registry_conflict", "registry");
  if (mapping && mapping.enabled !== true) fail("project_disabled", "registry");
  config.projects ??= {};
  config.projects[options.harness] ??= {};
  if (
    typeof config.projects[options.harness] !== "object" ||
    Array.isArray(config.projects[options.harness])
  )
    fail("project_configuration_invalid", "credentials");
  const credentials = config.projects[options.harness][options.bankId] ?? {};
  if (!credentials || typeof credentials !== "object" || Array.isArray(credentials))
    fail("project_configuration_invalid", "credentials");
  for (const role of ["readToken", "writeToken"])
    if (
      credentials[role] !== undefined &&
      (typeof credentials[role] !== "string" || !/^[^\s]{32,4096}$/.test(credentials[role]))
    )
      fail("project_credential_invalid", "credentials");
  return { directory, registryRaw, privateRaw, registry, config, mapping, credentials };
}
export function doctorLocalProject(options: LocalProjectOptions): ProjectChecks {
  const state = local(options);
  const checks = {
    registry: !!state.mapping,
    credentials: !!state.credentials.readToken && !!state.credentials.writeToken,
    name: state.mapping?.name === options.name,
  };
  return { checks, ready: Object.values(checks).every(Boolean) };
}
interface Staged {
  options: LocalProjectOptions;
  readToken: string;
  writeToken: string;
}
function pendingPath(options: LocalProjectOptions): string {
  return `${options.privateConfigFile}.bootstrap-${hash(options.bankId + "\0" + options.harness).slice(0, 16)}.pending`;
}
function stage(options: LocalProjectOptions): Staged {
  const state = local(options),
    path = pendingPath(options),
    raw = snapshot(path, true);
  if (raw !== null) {
    const staged = parse<Staged>(raw, {} as Staged, "credentials");
    if (
      JSON.stringify(staged.options) !== JSON.stringify(options) ||
      !/^[^\s]{32,4096}$/.test(staged.readToken ?? "") ||
      !/^[^\s]{32,4096}$/.test(staged.writeToken ?? "")
    )
      fail("project_staged_conflict", "credentials");
    for (const role of ["readToken", "writeToken"] as const)
      if (state.credentials[role] && state.credentials[role] !== staged[role])
        fail("project_credential_conflict", "credentials");
    return staged;
  }
  const staged: Staged = {
    options,
    readToken: state.credentials.readToken ?? randomBytes(32).toString("base64url"),
    writeToken: state.credentials.writeToken ?? randomBytes(32).toString("base64url"),
  };
  if (staged.readToken === staged.writeToken) fail("project_credential_conflict", "credentials");
  atomic(path, null, staged);
  return staged;
}
export function existingLocalProjectRequest(
  options: LocalProjectOptions
): RemoteProjectRequest | undefined {
  const state = local(options);
  if (!state.credentials.readToken || !state.credentials.writeToken) return undefined;
  return {
    bankId: options.bankId,
    name: options.name,
    harness: options.harness,
    readTokenHash: hash(state.credentials.readToken),
    writeTokenHash: hash(state.credentials.writeToken),
  };
}
export function prepareLocalProject(options: LocalProjectOptions): RemoteProjectRequest {
  const staged = stage(options);
  return {
    bankId: options.bankId,
    name: options.name,
    harness: options.harness,
    readTokenHash: hash(staged.readToken),
    writeTokenHash: hash(staged.writeToken),
  };
}
/** Call only with the successful remote result for this exact prepared request. */
export function completeLocalProject(
  options: LocalProjectOptions,
  result: ProjectChecks & { request: RemoteProjectRequest }
): ProjectChecks {
  const staged = stage(options),
    request = prepareLocalProject(options);
  if (!result.ready || JSON.stringify(result.request) !== JSON.stringify(request))
    fail("project_remote_not_ready", "commit");
  const state = local(options);
  state.config.endpoint = options.endpoint;
  state.config.projects[options.harness][options.bankId] = {
    ...state.credentials,
    readToken: staged.readToken,
    writeToken: staged.writeToken,
  };
  // Credentials first: an interrupted completion remains recoverable from the retained stage.
  if (
    JSON.stringify(parse(state.privateRaw, {} as PrivateConfig, "credentials")) !==
    JSON.stringify(state.config)
  )
    atomic(options.privateConfigFile, state.privateRaw, state.config);
  if (state.mapping) {
    state.mapping.name = options.name;
    state.mapping.enabled = true;
  } else
    state.registry.projects.push({
      root: state.directory,
      bankId: options.bankId,
      name: options.name,
      enabled: true,
    });
  if (
    JSON.stringify(parse(state.registryRaw, {} as Registry, "registry")) !==
    JSON.stringify(state.registry)
  )
    atomic(options.registryFile, state.registryRaw, state.registry);
  unlinkSync(pendingPath(options));
  return doctorLocalProject(options);
}
function identityChecks(config: RemoteConfig, request: RemoteProjectRequest): boolean[] {
  return [request.readTokenHash, request.writeTokenHash].map((tokenHash, i) => {
    const matches = config.clients.filter((c) => c.tokenHash === tokenHash);
    if (
      matches.some(
        (c) =>
          c.mode !== "project" ||
          c.bankId !== request.bankId ||
          c.harness !== request.harness ||
          !c.requireProjectBinding ||
          !c.read ||
          c.write !== !!i
      )
    )
      fail("project_identity_conflict", "identities");
    const roleMatches = config.clients.filter(
      (c) =>
        c.mode === "project" &&
        c.bankId === request.bankId &&
        c.harness === request.harness &&
        c.write === !!i
    );
    if (roleMatches.some((c) => c.tokenHash !== tokenHash))
      fail("project_identity_conflict", "identities");
    return matches.length === 1;
  });
}
export async function runRemoteProject(
  request: RemoteProjectRequest,
  serverConfigFile: string,
  action: "doctor" | "init"
): Promise<ProjectChecks & { request: RemoteProjectRequest }> {
  validate(request);
  if (
    Object.keys(request).some(
      (k) => !["bankId", "name", "harness", "readTokenHash", "writeTokenHash"].includes(k)
    )
  )
    fail("project_request_invalid", "identities");
  if (
    ![request.readTokenHash, request.writeTokenHash].every((h) => /^[a-f0-9]{64}$/.test(h)) ||
    request.readTokenHash === request.writeTokenHash
  )
    fail("project_token_hash_invalid", "identities");
  if (!["doctor", "init"].includes(action)) fail("project_action_invalid", "init");
  const original = snapshot(serverConfigFile, true);
  let config: RemoteConfig;
  try {
    config = loadRemoteConfig(serverConfigFile);
  } catch {
    return fail("project_server_configuration_invalid", "remote");
  }
  const identities = identityChecks(config, request);
  const newIds = identities.flatMap((present, i) =>
    present
      ? []
      : [
          `bootstrap-${hash(request.bankId + "\0" + request.harness).slice(0, 20)}-${i ? "write" : "read"}`,
        ]
  );
  if (
    config.clients.length + newIds.length > 100 ||
    newIds.some((id) => config.clients.some((c) => c.id === id))
  )
    fail("project_identity_conflict", "identities");
  const api = config.apiUrl.replace(/\/$/, "") + "/v1/default/banks",
    bankUrl = api + "/" + encodeURIComponent(request.bankId);
  async function call(url: string, method = "GET", body?: Json): Promise<BackendJson> {
    try {
      const response = await fetch(url, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(15000),
        headers: {
          "Content-Type": "application/json",
          ...(config.apiToken ? { Authorization: `Bearer ${config.apiToken}` } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return fail(
          response.status === 401 || response.status === 403
            ? "project_backend_access_denied"
            : "project_backend_request_failed",
          "backend"
        );
      }
      const reader = response.body?.getReader();
      let size = 0;
      const chunks: Uint8Array[] = [];
      if (reader) {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > 1024 * 1024) {
            await reader.cancel();
            fail("project_backend_response_too_large", "backend");
          }
          chunks.push(part.value);
        }
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (error) {
      if (error instanceof ProjectBootstrapError) throw error;
      return fail("project_backend_unavailable", "backend");
    }
  }
  async function findBank(): Promise<NonNullable<BackendJson["banks"]>[number] | undefined> {
    for (let offset = 0; offset < 10000; offset += 100) {
      const page = await call(`${api}?limit=100&offset=${offset}`);
      if (!Array.isArray(page.banks)) fail("project_backend_response_invalid", "bank");
      const banks = page.banks ?? fail("project_backend_response_invalid", "bank");
      const bank = banks.find((b) => b.bank_id === request.bankId);
      if (bank) return bank;
      if (banks.length < 100 || (typeof page.total === "number" && offset + 100 >= page.total))
        return undefined;
    }
    return fail("project_bank_listing_limit", "bank");
  }
  let bank = await findBank();
  if (bank?.name && bank.name !== request.name) fail("project_bank_name_conflict", "name");
  let bankConfig: BackendJson = bank ? await call(bankUrl + "/config") : {};
  const strategies = bankConfig.config?.retain_strategies ?? {};
  const existing = strategies[strategyName];
  // Existing missions may be deliberately customized. Accept the save contract, never overwrite it.
  if (
    existing &&
    (existing.retain_extraction_mode !== "concise" ||
      typeof existing.retain_mission !== "string" ||
      !existing.retain_mission.trim())
  )
    fail("project_strategy_conflict", "strategy");
  if (action === "init") {
    if (snapshot(serverConfigFile, true) !== original)
      fail("project_configuration_changed", "commit");
    if (!bank) {
      await call(bankUrl, "PUT", { name: request.name });
      bank = await findBank();
    } else if (!bank.name) {
      await call(bankUrl, "PATCH", { name: request.name });
      bank = await findBank();
    }
    if (!bank || bank.name !== request.name) fail("project_bank_name_unverified", "name");
    if (!existing) {
      // Re-read before writing so unrelated existing strategies are retained.
      bankConfig = await call(bankUrl + "/config");
      const current = bankConfig.config?.retain_strategies ?? {};
      if (current[strategyName]) fail("project_configuration_changed", "strategy");
      await call(bankUrl + "/config", "PATCH", {
        updates: { retain_strategies: { ...current, [strategyName]: PROJECT_CONCLUSION_STRATEGY } },
      });
    }
    for (let i = 0; i < identities.length; i++)
      if (!identities[i])
        config.clients.push({
          id: `bootstrap-${hash(request.bankId + "\0" + request.harness).slice(0, 20)}-${i ? "write" : "read"}`,
          tokenHash: i ? request.writeTokenHash : request.readTokenHash,
          mode: "project",
          bankId: request.bankId,
          harness: request.harness,
          requireProjectBinding: true,
          read: true,
          write: !!i,
        });
    if (identities.some((v) => !v)) atomic(serverConfigFile, original, config, true);
    // Reload schema after mutation: duplicates and client limits must not be silently accepted.
    config = loadRemoteConfig(serverConfigFile);
    bankConfig = await call(bankUrl + "/config");
  }
  const configured = bankConfig.config?.retain_strategies?.[strategyName];
  const checks = {
    bank: !!bank,
    name: bank?.name === request.name,
    strategy:
      configured?.retain_extraction_mode === "concise" &&
      typeof configured?.retain_mission === "string" &&
      !!configured.retain_mission.trim(),
    identities: identityChecks(config, request).every(Boolean),
  };
  return { request, checks, ready: Object.values(checks).every(Boolean) };
}
