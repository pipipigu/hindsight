import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./git-layout", () => ({ probeGitLayout: vi.fn(() => ({ status: "none" })) }));

import { deriveBankIdOrSkip } from "./bank";

/**
 * In registry mode an unmapped or disabled directory is a deliberate user choice. Recording it as
 * a warning + diag event on every prompt buried the real diagnostics (most lines were $HOME).
 */
describe("registry skips that are not faults", () => {
  let root: string;
  let registry: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hs-registry-skip-"));
    mkdirSync(join(root, "mapped"));
    mkdirSync(join(root, "disabled"));
    mkdirSync(join(root, "elsewhere"));
    registry = join(root, "projects.json");
    writeFileSync(
      registry,
      JSON.stringify({
        projects: [
          { root: join(root, "mapped"), bankId: "p-mapped", enabled: true },
          { root: join(root, "disabled"), bankId: "p-disabled", enabled: false },
        ],
      })
    );
    process.env.HINDSIGHT_DIAG_FILE = join(root, "diag.jsonl");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    delete process.env.HINDSIGHT_DIAG_FILE;
  });

  const cfg = () => ({ bankResolution: "registry" as const, projectRegistryFile: registry });

  it("skips unregistered and disabled directories without a diag event", () => {
    expect(deriveBankIdOrSkip(cfg(), join(root, "elsewhere"), "codex")).toBeNull();
    expect(deriveBankIdOrSkip(cfg(), join(root, "disabled"), "codex")).toBeNull();
    expect(existsSync(process.env.HINDSIGHT_DIAG_FILE as string)).toBe(false);
  });

  it("still resolves a mapped directory", () => {
    expect(deriveBankIdOrSkip(cfg(), join(root, "mapped"), "codex")).toBe("p-mapped");
  });

  it("still records a broken registry as a diagnosable fault", () => {
    writeFileSync(registry, "{not json");
    expect(deriveBankIdOrSkip(cfg(), join(root, "mapped"), "codex")).toBeNull();
    expect(existsSync(process.env.HINDSIGHT_DIAG_FILE as string)).toBe(true);
  });
});
