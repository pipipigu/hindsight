import { describe, expect, it } from "vitest";
import { projectDiagnostic } from "./project-diagnostics";

describe("public project diagnostics", () => {
  it.each([
    ["project_unregistered", "directory_registration"],
    ["project_registry_invalid", "directory_registration"],
    ["project_disabled", "directory_registration"],
    ["remote_mcp_config_invalid", "remote_configuration"],
    ["remote_project_credential_missing", "project_credentials"],
    ["project_bank_missing", "memory_bank"],
    ["remote_bank_missing", "memory_bank"],
    ["conclusion_strategy_missing", "retain_strategy"],
  ])("classifies %s without exception details", (code, stage) => {
    expect(projectDiagnostic(new Error(code))).toEqual({ error: code, code, stage });
  });
  it.each([
    new Error("project_SECRET_token"),
    new Error("/home/private Bearer token"),
    { message: "project_bank_missing", secret: "token" },
    "__proto__",
  ])("uses an exact whitelist and never releases an unknown error", (error) => {
    expect(projectDiagnostic(error)).toEqual({
      error: "memory_request_failed",
      code: "memory_request_failed",
      stage: "request",
    });
  });
});
