/** Public diagnostics contain only fixed codes and stages, never exception details. */
const stages = {
  project_unregistered: "directory_registration",
  remote_project_unregistered: "directory_registration",
  project_directory_missing: "directory_registration",
  invalid_project_path: "directory_registration",
  project_origin_unavailable: "directory_registration",
  project_registry_invalid: "directory_registration",
  project_disabled: "directory_registration",
  remote_project_disabled: "directory_registration",
  remote_mcp_config_invalid: "remote_configuration",
  remote_mcp_timeout: "remote_connection",
  remote_mcp_cancelled: "remote_connection",
  remote_mcp_connection_failed: "remote_connection",
  memory_endpoint_not_configured: "remote_configuration",
  remote_project_credential_missing: "project_credentials",
  project_bank_missing: "memory_bank",
  remote_bank_missing: "memory_bank",
  project_bank_unavailable: "memory_bank",
  conclusion_strategy_missing: "retain_strategy",
  tool_context_required: "trusted_context",
  trusted_workspace_required: "trusted_context",
  invalid_tool_context: "trusted_context",
  expired_or_changed_tool_context: "trusted_context",
  invalid_context_key: "trusted_context",
  wrong_harness_context: "trusted_context",
  remote_project_binding_invalid: "project_binding",
  remote_project_binding_changed: "project_binding",
  project_mapping_changed: "project_binding",
  project_bank_mismatch: "project_binding",
  project_scope_changed: "project_binding",
  remote_scope_changed: "project_binding",
  credential_scope_changed: "project_credentials",
  remote_credential_changed: "project_credentials",
  remote_authorization_changed: "permission",
  remote_access_denied: "permission",
  remote_write_denied: "permission",
  remote_policy_changed: "permission",
  remote_write_permission_denied: "permission",
  remote_request_denied: "permission",
  project_override_denied: "permission",
  remote_tool_context_override: "permission",
  plan_readonly: "permission",
  memory_readonly: "permission",
  host_permission_unavailable: "permission",
  tool_arguments_unavailable: "tool_arguments",
  tool_unavailable: "tool_arguments",
  remote_tool_unavailable: "tool_arguments",
  memory_not_found: "memory_read",
  memory_original_unavailable: "memory_read",
  memory_changed_restart_read: "memory_read",
  memory_output_budget_exceeded: "memory_read",
  invalid_memory_offset: "memory_read",
  memory_request_failed: "request",
  trusted_project_context_unavailable: "trusted_context",
} as const;
export type ProjectDiagnosticCode = keyof typeof stages;
export function projectDiagnostic(
  error: unknown,
  fallback: ProjectDiagnosticCode = "memory_request_failed"
): { error: ProjectDiagnosticCode; code: ProjectDiagnosticCode; stage: string } {
  const candidate = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const code = Object.hasOwn(stages, candidate) ? (candidate as ProjectDiagnosticCode) : fallback;
  return { error: code, code, stage: stages[code] };
}
export function projectErrorResult(error: unknown, fallback?: ProjectDiagnosticCode) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(projectDiagnostic(error, fallback)) }],
  };
}
