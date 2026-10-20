import { readRegistry } from "./core/project-registry";
import { pendingConclusionWorkspaces } from "./core/conclusions";
import { type PermissionMode } from "./core/tool-context";
import { buildKnowledgeTools } from "./core/knowledge-tools";
/**
 * DeepSeek Harness (`dsh`) entrypoint — a native Cordis plugin.
 *
 * dsh is plugin-first: its canonical extension surface is a set of typed lifecycle events, and its
 * Claude Code / Codex hook bridges are just translators onto that same surface. So this integration
 * binds the events directly instead of installing hook binaries — a bridge would cost the same
 * install (neither bridge ships in a default profile) while losing the transcript, the session id
 * and the awaited stop boundary.
 *
 *   agent/session-start  -> RuntimeCore.seedIfCold      (cold-check + background git/codebase seed)
 *   agent/pre-step       -> RuntimeCore.onPrompt        (recall) + the injection as a sourced message
 *   agent/turn-stopping  -> RuntimeCore.onSessionIdle   (write-back of the completed exchange)
 *   ctx.tools            -> the hindsight_* knowledge suite, registered natively
 *
 * ONE dsh PROCESS SERVES MANY WORKSPACES. Unlike opencode/Kilo/Cline — one process, one project —
 * dsh's Web UI creates sessions in whatever directory the user picks, each with its own
 * `session.header.cwd`. Memory is per-repo, so a RuntimeCore (bank, client, seed) is built PER
 * WORKSPACE ROOT and cached, never once per process.
 *
 * The plugin imports NOTHING from dsh at all: every host shape is structurally typed here, and the
 * tool definitions are built in dsh's own registry shape rather than through its `defineTool`
 * builder (see `toDshParameters`). So there is no dsh package for pnpm to resolve inside a profile,
 * and no version to keep in step — any dsh whose event names still match can load this file.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { resolveHostMemory, resolveCatalogMemory, loadHostConfig } from "./core/host-client";
import { diag } from "./core/diag";
import type { ToolSpec } from "./core/knowledge-tools";
import { log } from "./core/log";
import { RuntimeCore } from "./core/runtime";
import { fetchRemoteCatalog, fetchRemoteRules, callRemoteTool } from "./core/remote-mcp-bridge";
import { HINDSIGHT_PLUGIN, readDshEvents, type DshSessionEvent } from "./core/transcript-dsh";
import {
  assertMemoryWritable,
  memoryAccessFor,
  READ_ONLY_MEMORY_GUIDANCE,
  type MemoryAccess,
} from "./core/memory-access";

const HARNESS = "dsh";

/** Cordis plugin name (loader diagnostics, and the `source.plugin` on everything we inject). */
export const name = HINDSIGHT_PLUGIN;

/** The agent registry owns the lifecycle events below; without it there is nothing to bind. */
export const inject = ["agents"];

// ── host shapes (structural: this package must not depend on dsh's packages) ─────

interface DshSession {
  readonly header: { readonly id: string; readonly cwd?: string; readonly origin?: string };
  /**
   * Legacy in-memory event log. Present on DeepSeek Harness < alpha.4; removed in alpha.4+.
   * Prefer {@link snapshotEvents} when available.
   */
  readonly events?: readonly DshSessionEvent[];
  /** Public accessor on DeepSeek Harness alpha.4+ (replaces the removed `events` property). */
  snapshotEvents?(): readonly DshSessionEvent[];
}

interface DshAgent {
  readonly session: DshSession;
  /** Services such as planMode are scoped to the calling agent's preset. */
  readonly ctx?: { get?(name: string): unknown };
}

/** A `user/message` as dsh's pre-step decision carries it. */
interface DshUserMessage {
  role: "user";
  content: { type: string; text?: string }[];
  source: { kind: string; form?: string };
  id?: string;
}

type PreStepDecision =
  | { kind: "enter"; messages: DshUserMessage[] }
  | { kind: "reject"; [key: string]: unknown };

interface PreStepPayload {
  turn?: unknown;
  agent: DshAgent;
  signal: AbortSignal;
}

/** The Cordis context surface this plugin uses. */
interface DshContext {
  effect?(effect: () => () => void, label?: string): void;
  get?(name: string): unknown;
  on(
    event: "agent/session-start",
    listener: (payload: { agent: DshAgent }) => void
  ): (() => void) | void;
  on(
    event: "agent/pre-step",
    listener: (
      payload: PreStepPayload,
      next: () => Promise<PreStepDecision>
    ) => Promise<PreStepDecision>,
    options?: { prepend?: boolean }
  ): (() => void) | void;
  on(
    event: "agent/turn-stopping",
    listener: (payload: { agent: DshAgent }) => Promise<void> | void
  ): (() => void) | void;
  on(
    event: "agent/disposed",
    listener: (payload: { agent: DshAgent }) => void
  ): (() => void) | void;
  on(event: "tools/change", listener: () => void): (() => void) | void;
  inject(
    names: string[],
    callback: (ctx: DshToolContext) => void | Promise<void>
  ): void | PromiseLike<unknown>;
}

interface DshToolContext extends Pick<DshContext, "on" | "effect"> {
  tools: {
    register(definition: unknown): void;
    guard?(
      guard: (execution: { name: string; agent?: DshAgent }) => string | undefined
    ): () => void;
    /** Registry introspection; used only to log what the host ended up exposing. */
    schemas?(): { name: string }[];
  };
}

interface DshScopedTools {
  restrict?(filter: { deny: string[] }): () => void;
  schemas?(scope?: DshAgent): { name: string }[];
}

/** Hide writes per caller without narrowing the shared host catalog for human sessions. */
function bindDshMemoryPermissions(
  toolCtx: DshToolContext,
  catalog: readonly { name: string; annotations?: { readOnlyHint?: boolean } }[]
): void {
  // Derive from the registered catalog so new writes and unannotated tools fail closed too.
  const writes = new Set(
    catalog.filter((tool) => tool.annotations?.readOnlyHint !== true).map((tool) => tool.name)
  );
  const restrictions = new Map<
    DshAgent,
    { masked: Set<string>; disposers: (() => void)[]; installing: boolean }
  >();
  let disposing = false;
  const disposeGuard = toolCtx.tools.guard?.((execution) =>
    writes.has(execution.name) &&
    memoryAccessFor(execution.agent?.session.header.origin) === "read-only"
      ? "memory_readonly"
      : undefined
  );
  function restrict(agent: DshAgent): void {
    if (disposing || memoryAccessFor(agent.session.header.origin) !== "read-only") return;
    const tools = agent.ctx?.get?.("tools") as DshScopedTools | undefined;
    if (!tools?.restrict || !tools.schemas) return;
    let state = restrictions.get(agent);
    if (!state) {
      state = { masked: new Set(), disposers: [], installing: false };
      restrictions.set(agent, state);
    }
    if (state.installing) return;
    // The host rejects unknown deny names; a read-only remote identity may already omit writes.
    const deny = tools
      .schemas(agent)
      .map((tool) => tool.name)
      .filter((name) => writes.has(name) && !state.masked.has(name));
    if (!deny.length) return;
    // restrict emits tools/change synchronously: publish the in-progress mask before calling it.
    state.installing = true;
    for (const name of deny) state.masked.add(name);
    try {
      state.disposers.push(tools.restrict({ deny }));
    } catch (error) {
      for (const name of deny) state.masked.delete(name);
      throw error;
    } finally {
      state.installing = false;
    }
  }
  const listeners = [toolCtx.on("agent/session-start", ({ agent }) => restrict(agent))];
  listeners.push(
    toolCtx.on("tools/change", () => {
      for (const agent of restrictions.keys()) restrict(agent);
    })
  );
  listeners.push(
    toolCtx.on(
      "agent/pre-step",
      async ({ agent }, next) => {
        // Also covers restored sessions and agents that predate plugin hot reload.
        restrict(agent);
        return next();
      },
      { prepend: true }
    )
  );
  listeners.push(
    toolCtx.on("agent/disposed", ({ agent }) => {
      const state = restrictions.get(agent);
      restrictions.delete(agent);
      for (const dispose of state?.disposers ?? []) dispose();
    })
  );
  toolCtx.effect?.(
    () => () => {
      disposing = true;
      const states = [...restrictions.values()];
      restrictions.clear();
      for (const dispose of listeners) dispose?.();
      disposeGuard?.();
      for (const state of states) {
        for (const dispose of state.disposers) dispose();
      }
    },
    "hindsight.memory-permissions"
  );
}

/** `exec` as a dsh tool body receives it (only the caller matters to us). */
interface DshToolRunContext {
  readonly agent?: DshAgent;
  readonly signal?: AbortSignal;
}

// ── per-workspace runtime cache ─────────────────────────────────────────────────

export interface Workspace {
  core: RuntimeCore;
  root: string;
  /** Started by the first SESSION in this repo, then shared by every later one. */
  seeded?: Promise<void>;
  tools?: ToolSpec[];
}

/** `null` caches "memory is off for this repo" so a disabled bank isn't re-derived every turn. */
const workspaces = new Map<string, Workspace | null>();
/**
 * sessionId -> agent, so a core's transcript source (which only receives the id) can read the live
 * log back on stop. `agent/disposed` is what bounds it: an agent holds its whole session log, so
 * dropping the entry when the host disposes the agent is what keeps a long-lived Web server from
 * pinning every session it ever opened.
 */
const liveAgents = new Map<string, DshAgent>();

/**
 * Prefer `session.snapshotEvents()` (DeepSeek Harness alpha.4+); fall back to the legacy
 * `session.events` property so older hosts keep working. Missing both yields an empty log —
 * which is exactly the alpha.4 breakage when callers still read `events` alone.
 */
export function dshSessionEvents(
  session: Pick<DshSession, "snapshotEvents" | "events">
): readonly DshSessionEvent[] {
  return session.snapshotEvents?.() ?? session.events ?? [];
}

/** Where a session is working. dsh records it on the session header; a session without one is rare. */
function workspaceRoot(agent: DshAgent): string {
  return agent.session.header.cwd || process.cwd();
}

/**
 * The memory runtime for one workspace root, built on first use.
 *
 * Bank derivation and the per-bank opt-out live here rather than in `apply`, because the plugin
 * loads before any session exists and the process may end up serving several unrelated
 * repositories. Building one has NO side effect: the seed is started by `ensureSeeded` when a
 * session actually opens, so merely registering the tools never seeds the launch directory.
 */
let registryRevision = "";
function workspaceFor(
  root: string,
  access: MemoryAccess = memoryAccessFor()
): Workspace | undefined {
  const cfg0 = loadHostConfig(HARNESS);
  if (cfg0.bankResolution === "registry") {
    try {
      const revision = readRegistry(cfg0.projectRegistryFile).revision;
      if (revision !== registryRevision) {
        for (const work of workspaces.values()) work?.core.dispose();
        workspaces.clear();
        registryRevision = revision;
      }
    } catch {
      for (const work of workspaces.values()) work?.core.dispose();
      workspaces.clear();
      return undefined;
    }
  }
  // A read-only worker may share a directory with its parent, but must not start that parent's
  // pending-save delivery or page maintenance when its first query creates a runtime.
  const cacheKey = JSON.stringify([root, access]);
  const cached = workspaces.get(cacheKey);
  if (cached !== undefined) return cached ?? undefined;

  // One shared builder for every long-lived host (core/host-client.ts): the global switch, the
  // per-bank opt-out and `optInOnly` all land in `cfg.disabled`.
  const { cfg, bankId, client } = resolveHostMemory(HARNESS, root);
  if (cfg.disabled) {
    workspaces.set(cacheKey, null); // inert: same agent, no memory (baseline parity)
    return undefined;
  }
  // The 5th argument is this host's whole reason for existing here: RuntimeCore binds the
  // knowledge tools (and retain stamps) to the workspace it is given, and dsh's process cwd is the
  // launch directory, routinely a different repository from the session's.
  const core = new RuntimeCore(client, bankId, cfg, HARNESS, root, access);
  // The write-back path reads the log back off the live agent — dsh keeps the whole session in
  // memory, so unlike opencode there is nothing to refetch over HTTP.
  core.setTranscriptSource(async (sessionId) => {
    const agent = liveAgents.get(sessionId);
    // alpha.4+ removed Session.events; snapshotEvents() is the public accessor.
    return agent ? readDshEvents(dshSessionEvents(agent.session)) : [];
  });
  const workspace: Workspace = { core, root };
  workspaces.set(cacheKey, workspace);
  return workspace;
}

/**
 * Start this repo's cold-check + background seed once.
 *
 * Fire-and-forget by design: `agent/session-start` is an emit that no extension point awaits, and
 * the Web UI must not wait on a network round-trip to open a session. Nothing the first prompt
 * needs comes from here — it builds its own knowledge preamble from that session's page list.
 */
function ensureSeeded(workspace: Workspace): void {
  workspace.seeded ??= workspace.core.seedIfCold(workspace.root);
}

function workspaceForAgent(agent: DshAgent, allowSubagentQueries = false): Workspace | undefined {
  if (loadHostConfig(HARNESS).bankResolution === "registry" && !agent.session.header.cwd)
    return undefined;
  // A subagent session is a child of a conversation we already track: injecting into it would pay
  // for a second recall per delegation, and retaining it would file a fragment of a session that
  // the parent already stores in full.
  if (agent.session.header.origin === "subagent" && !allowSubagentQueries) return undefined;
  return workspaceFor(workspaceRoot(agent), memoryAccessFor(agent.session.header.origin));
}

// ── message helpers ─────────────────────────────────────────────────────────────

/**
 * The human text in this step's claimed batch.
 *
 * `agent/pre-step` fires before EVERY step, including tool continuations that claimed no new input,
 * and other plugins contribute their own context messages to the same batch (V3 hosts tag them
 * `kind: 'plugin'`, V4 hosts use a producer-owned kind such as `time-context`). Only a
 * `kind: 'user'` message is a prompt worth recalling on.
 */
function promptOf(messages: readonly DshUserMessage[]): string {
  return (messages || [])
    .filter((message) => message?.source?.kind === "user")
    .flatMap((message) => message.content || [])
    .filter((block) => block?.type === "text" && block.text)
    .map((block) => block.text!)
    .join("\n")
    .trim();
}

/**
 * Build the injected memory message.
 *
 * `form: 'recall'` is dsh's own vocabulary for retrieved context, so its UI renders the block as
 * recalled material rather than as something the user typed. Session format V4 requires injected
 * messages to use a producer-owned source kind; `plugin:hindsight` is the canonical fallback name
 * for an unregistered plugin. The non-user source also keeps the block out of a write-back.
 */
function injectionMessage(text: string): DshUserMessage {
  return {
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: `plugin:${HINDSIGHT_PLUGIN}`, form: "recall" },
  };
}

// ── the lifecycle, testable without a dsh host ──────────────────────────────────

/**
 * The three lifecycle handlers, over an injectable workspace resolver. `apply` binds these to the
 * real Cordis events; the tests drive them with a stand-in agent and core.
 */
export function createDshHooks(
  resolve: (agent: DshAgent) => Workspace | undefined,
  modeFor: (agent: DshAgent) => PermissionMode = () => "unknown"
) {
  const seen = new WeakMap<object, Set<string>>();
  return {
    sessionStart({ agent }: { agent: DshAgent }): void {
      const workspace = resolve(agent);
      if (!workspace) return;
      liveAgents.set(agent.session.header.id, agent);
      ensureSeeded(workspace);
    },

    async preStep(
      { agent, signal, turn }: PreStepPayload,
      next: () => Promise<PreStepDecision>
    ): Promise<PreStepDecision> {
      const decision = await next();
      if (decision.kind !== "enter" || signal.aborted) return decision;
      const workspace = resolve(agent);
      if (!workspace) return decision;
      const sessionId = agent.session.header.id;
      liveAgents.set(sessionId, agent);
      // A resumed session gets no `agent/session-start` in some compositions; seeding here too
      // keeps the cold-check exactly-once without depending on which events a host fired.
      ensureSeeded(workspace);
      // No new human input means a tool continuation: recall already ran for this turn, and its
      // block is already in the history the model is about to be sent.
      const prompt = promptOf(decision.messages);
      if (!prompt) return decision;
      const key = JSON.stringify([
        turn,
        decision.messages.filter((m) => m.source.kind === "user").map((m) => m.id),
        prompt,
      ]);
      const previous = seen.get(agent.session) ?? new Set<string>();
      if (previous.has(key)) return decision;
      previous.add(key);
      if (previous.size > 200) previous.delete(previous.values().next().value!);
      seen.set(agent.session, previous);
      void workspace.core.prepareSharedPages?.(modeFor(agent))?.catch(() => {});
      await workspace.core.onPrompt(sessionId, prompt);
      const injection = workspace.core.getInjection(sessionId);
      if (!injection) {
        diag(HARNESS, "inject_empty", { session: sessionId });
        return decision;
      }
      diag(HARNESS, "inject_ok", { session: sessionId, chars: injection.length });
      return { kind: "enter", messages: [...decision.messages, injectionMessage(injection)] };
    },

    async turnStopping({ agent }: { agent: DshAgent }): Promise<void> {
      const workspace = resolve(agent);
      if (!workspace) return;
      const sessionId = agent.session.header.id;
      liveAgents.set(sessionId, agent);
      // The stop boundary is the only moment the completed exchange is readable, so this bypasses
      // the turn cadence exactly like the opencode idle path it shares (`onSessionIdle`).
      await workspace.core.onSessionIdle(sessionId);
    },

    disposed({ agent }: { agent: DshAgent }): void {
      liveAgents.delete(agent.session.header.id);
    },
  };
}

// ── native tools ────────────────────────────────────────────────────────────────

/**
 * Project one harness-agnostic ToolSpec's input onto the JSON Schema dsh's registry stores.
 *
 * dsh's own `defineTool` is a pure builder — it compiles this exact schema shape and wraps the
 * callbacks — and `ctx.tools.register` validates a definition structurally, not by module identity.
 * Building the schema here therefore keeps the plugin free of a `@deepseek-ai/dsh-tools` dependency
 * that pnpm would have to resolve inside the profile, at the cost of one small projection.
 *
 * Project the same Zod shape as MCP/Pi, including arrays, numeric budgets, booleans and nested
 * include/filter options. Dropping these constraints changes the meaning of a Recall request.
 */
export function toDshParameters(spec: ToolSpec): Record<string, unknown> {
  const { $schema: _schema, ...parameters } = z.toJSONSchema(z.object(spec.inputSchema).strict(), {
    target: "draft-7",
    io: "input",
  });
  return parameters;
}

/** The tool bodies return MCP-shaped results and never throw; dsh wants a value or a throw. */
export async function runDshTool(
  spec: ToolSpec,
  args: Record<string, unknown>,
  permission: PermissionMode,
  access: MemoryAccess = memoryAccessFor()
): Promise<string> {
  if (spec.annotations?.readOnlyHint !== true) assertMemoryWritable(access);
  const result = await spec.handler(args, { permission });
  const text = (result.content || []).map((block) => block.text).join("\n");
  // dsh normalizes a thrown tool body into an isError result with this message, which is exactly
  // what our isError:true means — mapping it any other way would report a failure as a success.
  if (result.isError) throw new Error(text || "hindsight tool failed");
  return text;
}

/**
 * Register the hindsight_* suite on `ctx.tools`.
 *
 * The dsh tools registry is host+per-scope layered, so a host-plane registration is visible to
 * every agent — including the Web surface's per-session agent presets. Each call resolves the bank
 * from the CALLING agent's workspace, because one process serves many repositories.
 */
function registerTools(
  toolCtx: DshToolContext,
  fallbackRoot: string,
  modeFor: (agent?: DshAgent) => PermissionMode
): ToolSpec[] {
  // The registry is populated at plugin load, before any session exists, so the NAMES and schemas
  // come from the launch directory's workspace and each call rebinds to its own caller's bank. The
  // one consequence: if memory is off for the launch directory specifically (a `banks.<id>`
  // opt-out) the tools are absent even for other repositories this process later serves.
  const template = workspaceFor(fallbackRoot);
  const cfg = loadHostConfig(HARNESS);
  if (!template && (cfg.disabled || cfg.bankResolution !== "registry")) return [];
  const catalog = template
    ? specsOf(template)
    : buildKnowledgeTools(resolveCatalogMemory(HARNESS, fallbackRoot).client, "", {
        harness: HARNESS,
      });
  for (const spec of catalog) {
    toolCtx.tools.register({
      name: spec.name,
      description: spec.description,
      parameters: toDshParameters(spec),
      output: {
        schema: { type: "string" },
        render: (_args: unknown, value: string) => [{ type: "text", text: value }],
      },
      async execute(args: Record<string, unknown>, exec: DshToolRunContext): Promise<string> {
        // Reject before resolving the bank or parsing connection configuration.
        if (spec.annotations?.readOnlyHint !== true)
          assertMemoryWritable(memoryAccessFor(exec?.agent?.session.header.origin));
        // Bind to the caller's repository, not to whichever workspace happened to load first.
        const workspace = exec?.agent
          ? workspaceForAgent(exec.agent, true)
          : cfg.bankResolution === "registry"
            ? undefined
            : template;
        if (!workspace) return "Hindsight memory is disabled for this workspace.";
        const bound = workspace.core.toolSpecs().find((candidate) => candidate.name === spec.name);
        if (!bound) return `Hindsight tool ${spec.name} is unavailable.`;
        return runDshTool(
          bound,
          args,
          modeFor(exec?.agent),
          memoryAccessFor(exec?.agent?.session.header.origin)
        );
      },
    });
  }
  // Log what the HOST sees, not just what we handed it: a tool that registers cleanly but never
  // reaches a model is the failure mode worth catching, and this is the one line that shows it.
  const exposed = toolCtx.tools.schemas?.() ?? [];
  log.debug(HARNESS, "tools registered", {
    count: catalog.length,
    hostCatalog: exposed.length,
    hindsight: exposed.filter((schema) => schema.name?.startsWith("hindsight_")).length,
  });
  return catalog;
}

/** The tool specs for one workspace, built once (each closes over that bank's client and root). */
function specsOf(workspace: Workspace): ToolSpec[] {
  workspace.tools ??= workspace.core.toolSpecs();
  return workspace.tools;
}

// ── cordis entrypoint ───────────────────────────────────────────────────────────

/** NAS mode owns only transport and host context; all public rules and schemas are remote. */
export async function applyRemoteDsh(ctx: DshContext): Promise<void> {
  const lifetime = new AbortController();
  const sessions = new WeakMap<DshSession, AbortController>();
  const active = new Set<AbortController>();
  const seen = new WeakMap<DshSession, Set<string>>();
  ctx.effect?.(
    () => () => {
      lifetime.abort();
      for (const controller of active) controller.abort();
      active.clear();
    },
    "hindsight.remote-mcp"
  );
  function sessionSignal(agent: DshAgent): AbortSignal {
    let controller = sessions.get(agent.session);
    if (!controller) {
      controller = new AbortController();
      sessions.set(agent.session, controller);
      active.add(controller);
    }
    return controller.signal;
  }
  ctx.on("agent/disposed", ({ agent }) => {
    const controller = sessions.get(agent.session);
    controller?.abort();
    if (controller) active.delete(controller);
    sessions.delete(agent.session);
    seen.delete(agent.session);
  });
  ctx.on(
    "agent/pre-step",
    async ({ agent, signal, turn }, next) => {
      const decision = await next();
      const cwd = agent.session.header.cwd;
      if (decision.kind !== "enter" || signal.aborted || !cwd || !promptOf(decision.messages))
        return decision;
      const key = JSON.stringify([
        turn,
        decision.messages.filter((m) => m.source.kind === "user").map((m) => m.id),
        promptOf(decision.messages),
      ]);
      const previous = seen.get(agent.session) ?? new Set<string>();
      if (previous.has(key)) return decision;
      previous.add(key);
      if (previous.size > 200) previous.delete(previous.values().next().value!);
      seen.set(agent.session, previous);
      const combined = AbortSignal.any([signal, lifetime.signal, sessionSignal(agent)]);
      let rules: string | null;
      try {
        // Per-turn discovery must not consume the longer startup/hook connection budget.
        rules = await fetchRemoteRules(HARNESS, cwd, combined, 2500);
      } catch {
        if (combined.aborted) return decision;
        rules = "Hindsight NAS MCP 连接不可用；本轮未获取公共记忆规则。";
        diag(HARNESS, "remote_rules_unavailable", { session: agent.session.header.id });
      }
      if (!rules || combined.aborted) return decision;
      return {
        kind: "enter",
        messages: [
          ...decision.messages,
          injectionMessage(
            `${rules}\n当前宿主：DSH；权限状态：${dshPermissionMode(agent)}。项目由本会话工作目录绑定，模型不得覆盖库或权限。${
              memoryAccessFor(agent.session.header.origin) === "read-only"
                ? "\n" + READ_ONLY_MEMORY_GUIDANCE
                : ""
            }`
          ),
        ],
      };
    },
    { prepend: true }
  );

  // Installed Cordis fiber._execute awaits callback.then(safeCollect), and inject returns a
  // PromiseLike fiber. Await the child so the catalog is registered before plugin startup ends.
  await ctx.inject(["tools"], async (toolCtx) => {
    const catalog = await fetchRemoteCatalog(HARNESS, loadHostConfig(HARNESS), lifetime.signal);
    if (lifetime.signal.aborted) return;
    for (const spec of catalog.tools) {
      toolCtx.tools.register({
        name: spec.name,
        description: spec.description ?? "",
        parameters: spec.inputSchema,
        output: {
          schema: { type: "string" },
          render: (_args: unknown, value: string) => [{ type: "text", text: value }],
        },
        async execute(args: Record<string, unknown>, exec: DshToolRunContext): Promise<string> {
          const agent = exec?.agent;
          const cwd = agent?.session.header.cwd;
          if (!agent || !cwd) throw new Error("remote_project_context_missing");
          const access = memoryAccessFor(agent.session.header.origin);
          if (spec.annotations?.readOnlyHint !== true) assertMemoryWritable(access);
          const signal = AbortSignal.any([
            lifetime.signal,
            sessionSignal(agent),
            ...(exec.signal ? [exec.signal] : []),
          ]);
          const result = await callRemoteTool(
            HARNESS,
            cwd,
            dshPermissionMode(agent),
            spec.name,
            args,
            signal,
            access
          );
          const text = result.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n");
          if (result.isError) throw new Error(text || "hindsight tool failed");
          return text;
        },
      });
    }
    bindDshMemoryPermissions(toolCtx, catalog.tools);
  });
}

/** Read permission state from the caller's scoped preset, never the plugin's global context. */
export function dshPermissionMode(agent?: DshAgent): PermissionMode {
  if (!agent) return "unknown";
  try {
    const plan = agent.ctx?.get?.("planMode") as
      | {
          get?: (a: DshAgent) => { active?: boolean; pending?: boolean };
          loggedActiveAtLastHeader?: (s: DshSession) => boolean | undefined;
        }
      | undefined;
    if (!plan) {
      // Preset services can be isolated below agent.ctx. The public projection service still
      // owns the authoritative logged state and pending human /plan command selection.
      const projections = agent.ctx?.get?.("sessionProjections") as
        | { stateOf?(session: DshSession, key: string): unknown }
        | undefined;
      const state = projections?.stateOf?.(agent.session, "plan") as
        | {
            active?: unknown;
            wanted?: unknown;
            running?: { wanted?: unknown } | null;
            activeAtLastHeader?: unknown;
          }
        | undefined;
      if (!state || typeof state.active !== "boolean") return "unknown";
      const wanted = state.running?.wanted ?? state.wanted;
      if (
        (wanted != null && typeof wanted !== "boolean") ||
        (state.activeAtLastHeader != null && typeof state.activeAtLastHeader !== "boolean")
      )
        return "unknown";
      return state.active || wanted === true || state.activeAtLastHeader === true
        ? "plan"
        : "normal";
    }
    const state = plan?.get?.(agent);
    const header = plan?.loggedActiveAtLastHeader?.(agent.session);
    if (
      (state?.pending !== undefined && typeof state.pending !== "boolean") ||
      (header !== undefined && typeof header !== "boolean")
    )
      return "unknown";
    if (state?.active === true || state?.pending === true || header === true) return "plan";
    return state?.active === false ? "normal" : "unknown";
  } catch (error) {
    diag(HARNESS, "permission_unavailable", {
      session: agent.session.header.id,
      reason: error instanceof Error ? error.message.slice(0, 200) : "plan_state_unreadable",
    });
    return "unknown";
  }
}

/** Bind listeners and tools to the owning Cordis fiber. */
export function apply(ctx: DshContext): void | Promise<void> {
  if (loadHostConfig(HARNESS).remoteMcpConfigFile) return applyRemoteDsh(ctx);
  ctx.effect?.(
    () => () => {
      for (const work of workspaces.values()) work?.core.dispose();
      workspaces.clear();
    },
    "hindsight.shared-delivery"
  );
  const cfg = loadHostConfig(HARNESS);
  if (!cfg.disabled && cfg.bankResolution === "registry" && memoryAccessFor() !== "read-only") {
    try {
      for (const pending of pendingConclusionWorkspaces()) {
        if (pending.harness !== HARNESS) continue;
        const workspace = workspaceFor(pending.cwd);
        if (workspace) void workspace.core.resumeConclusions().catch(() => {});
      }
    } catch (error) {
      log.warn(HARNESS, "pending conclusion recovery unavailable", { error: String(error) });
    }
  }
  const hooks = createDshHooks(workspaceForAgent, dshPermissionMode);
  ctx.on("agent/session-start", hooks.sessionStart);
  // `prepend: true` puts this listener outermost, so the injection is appended AFTER every other
  // contributor's messages — the memory block reads last, closest to the model's turn.
  ctx.on("agent/pre-step", hooks.preStep, { prepend: true });
  ctx.on("agent/turn-stopping", hooks.turnStopping);
  ctx.on("agent/disposed", hooks.disposed);
  // The tools registry is optional: a composition without it (a bare headless assembly) still gets
  // recall, injection and write-back.
  ctx.inject(["tools"], (toolCtx) => {
    const catalog = registerTools(toolCtx, process.cwd(), dshPermissionMode);
    bindDshMemoryPermissions(toolCtx, catalog);
  });
}

export default { name, inject, apply };
