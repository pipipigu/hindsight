#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { permissionMode, signToolContext } from "./core/tool-context";
import { projectDiagnostic } from "./core/project-diagnostics";
import { loadConfig } from "./core/config";
import { resolveRegisteredProject } from "./core/project-registry";

try {
  const ev = JSON.parse(readFileSync(0, "utf8")) as Record<string, unknown>;
  const name = String(ev.tool_name ?? "");
  const candidate = name.split("__").at(-1) ?? "";
  const tool = /^hindsight_[a-z_]+$/.test(candidate) ? candidate : undefined;
  if (
    ev.hook_event_name === "PreToolUse" &&
    tool &&
    (name.startsWith("mcp__hindsight__") || name.startsWith("hindsight_"))
  ) {
    const arg = process.argv[2];
    const harness = arg === "claude-code" || arg === "codebuddy" ? arg : "codex";
    const cfg = loadConfig({ harness });
    if (cfg.bankResolution === "registry") {
      if (cfg.disabled) throw new Error("project_disabled");
      if (typeof ev.cwd !== "string" || typeof ev.session_id !== "string")
        throw new Error("trusted_workspace_required");
      resolveRegisteredProject(ev.cwd, cfg.projectRegistryFile);
      const input = (ev.tool_input ?? {}) as Record<string, unknown>;
      const _context = signToolContext(
        {
          cwd: ev.cwd,
          harness,
          session: ev.session_id,
          mode: permissionMode(ev.permission_mode),
          tool,
        },
        input
      );
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            // Codex rejects an argument rewrite unless its hook explicitly allows the call.
            ...(harness === "codex" ? { permissionDecision: "allow" } : {}),
            updatedInput: { ...input, _context },
          },
        })
      );
    }
  }
} catch (e) {
  const diagnostic = projectDiagnostic(e, "trusted_project_context_unavailable");
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `Hindsight project context unavailable: ${diagnostic.code} (${diagnostic.stage})`,
      },
    })
  );
}
