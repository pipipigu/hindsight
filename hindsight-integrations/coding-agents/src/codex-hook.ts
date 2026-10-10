#!/usr/bin/env node
/**
 * hindsight-codex-hook — the OpenAI Codex CLI entry point (a `UserPromptSubmit` hook).
 *
 * Codex CLI (`[features] hooks = true` where needed) speaks a Claude-Code-compatible hook protocol
 * (see the hindsight-codex integration): event on stdin with session_id and prompt (or
 * user_prompt), output via hookSpecificOutput.additionalContext.
 *
 * Install (~/.codex/hooks.json):
 *   { "hooks": { "UserPromptSubmit": [ { "hooks": [
 *       { "type": "command", "command": "hindsight-codex-hook" } ] } ] } }
 *
 * Registry tool-only mode: every user prompt injects instructions for the model to decide whether
 * it needs historical evidence. The hook itself never searches memory. Other autoInject modes
 * use the shared runtime in core/hook.ts. Config: layered files, harness name "codex".
 */
import { runHarnessPrompt } from "./harness/hook-lifecycle";

void runHarnessPrompt("codex");
