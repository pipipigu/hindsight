import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig, type RawConfig } from "./config";
import { HindsightClient } from "./hindsight";
import { runHook } from "./hook";
import { runSessionStartHook } from "./session-start";
import { runRetainHook } from "./retain-hook";
import { startBackgroundSeed } from "./seed";
import { startCodebaseSurvey } from "./survey";
import { appendJournalTurn } from "./turn-journal";

let stdin = "";
let rawConfig: RawConfig;
let root: string;
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    readFileSync: (target: unknown, ...rest: unknown[]) =>
      target === 0
        ? stdin
        : (original.readFileSync as (...args: unknown[]) => unknown)(target, ...rest),
  };
});
vi.mock("./config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./config")>()),
  loadConfig: () => resolveConfig(rawConfig),
}));
vi.mock("./seed", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./seed")>()),
  startBackgroundSeed: vi.fn(),
}));
vi.mock("./survey", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./survey")>()),
  startCodebaseSurvey: vi.fn(async () => true),
}));
vi.mock("./git", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./git")>()),
  hasGitHistory: () => true,
  gitHeadSha: () => "fixture-head",
}));
vi.mock("./turn-journal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./turn-journal")>()),
  appendJournalTurn: vi.fn(),
}));
vi.mock("./daemon", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./daemon")>()),
  ensureDaemon: vi.fn(async () => true),
}));
vi.mock("./auto-update", () => ({ maybeAutoUpdate: vi.fn() }));
vi.mock("./skill-sync", () => ({ syncCompanionSkill: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("HINDSIGHT_MEMORY_ACCESS", "read-write");
  root = mkdtempSync(join(tmpdir(), "hs-hook-readonly-"));
  vi.stubEnv("HINDSIGHT_DIAG_FILE", join(root, "diag.log"));
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  rawConfig = {
    bankResolution: "upstream",
    autoSeed: true,
    codebaseSurvey: true,
    retainSessions: true,
    autoInject: "none",
    autoUpdate: false,
  };
  stdin = JSON.stringify({ cwd: root, session_id: root, permission_mode: "normal" });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe("read-only memory in independent hook processes", () => {
  it.each(["read-only", "unexpected", "read-write"])(
    "keeps prompt queries while gating both seed fallbacks and journals for %s",
    async (access) => {
      vi.stubEnv("HINDSIGHT_MEMORY_ACCESS", access);
      const client = new HindsightClient({ apiUrl: "http://fixture", bank: "fixture" });
      const listPages = vi.spyOn(client, "listPages").mockResolvedValue({ items: [] });
      const emit = vi.fn((context) => ({ context }));
      await runHook(
        {
          harness: "claude-code",
          journalPrompt: true,
          parse: () => ({ cwd: root, sessionId: root, prompt: "project facts" }),
          emit,
        },
        () => client
      );
      expect(listPages).toHaveBeenCalledTimes(1);
      expect(startBackgroundSeed).toHaveBeenCalledTimes(access === "read-write" ? 2 : 0);
      expect(appendJournalTurn).toHaveBeenCalledTimes(access === "read-write" ? 1 : 0);
      if (access !== "read-write") expect(emit.mock.calls[0][0]).toContain("只读");
    }
  );
  it.each(["read-only", "unexpected", "read-write"])(
    "gates SessionStart seed, survey, baseline and page writes for %s",
    async (access) => {
      vi.stubEnv("HINDSIGHT_MEMORY_ACCESS", access);
      const registry = join(root, "registry.json");
      writeFileSync(
        registry,
        JSON.stringify({ projects: [{ root, bankId: "fixture", enabled: true }] })
      );
      rawConfig = { ...rawConfig, bankResolution: "registry", projectRegistryFile: registry };
      const client = new HindsightClient({ apiUrl: "http://fixture", bank: "fixture" });
      vi.spyOn(client, "listPages").mockResolvedValue({ items: [] });
      vi.spyOn(client, "listDocumentIds").mockResolvedValue(new Set());
      const seedPages = vi.spyOn(client, "seedPages").mockResolvedValue(undefined);
      const retain = vi.spyOn(client, "retain").mockResolvedValue(undefined);
      const emit = vi.fn((output) => output);
      const makeClient = vi.fn(() => client);
      await runSessionStartHook(
        { harness: "claude-code", parse: () => ({ cwd: root, sessionId: root }), emit },
        makeClient
      );
      expect(makeClient).toHaveBeenCalledTimes(1);
      const expectedWrites = access === "read-write" ? 1 : 0;
      expect(seedPages).toHaveBeenCalledTimes(expectedWrites);
      expect(startBackgroundSeed).toHaveBeenCalledTimes(expectedWrites);
      expect(startCodebaseSurvey).toHaveBeenCalledTimes(expectedWrites);
      expect(retain).toHaveBeenCalledTimes(expectedWrites);
      expect(emit).toHaveBeenCalledTimes(1);
      if (access !== "read-write")
        expect(emit.mock.calls[0][0].additionalContext).toContain("只读");
    }
  );
  it.each(["read-only", "unexpected"])(
    "stops transcript backfill before journal parsing or client construction for %s",
    async (access) => {
      vi.stubEnv("HINDSIGHT_MEMORY_ACCESS", access);
      const parse = vi.fn(() => ({ cwd: root, sessionId: root, transcriptPath: "/fixture" }));
      const makeClient = vi.fn();
      await runRetainHook(
        {
          harness: "claude-code",
          hostTimeoutSec: 60,
          parse,
          journal: { assistantText: () => "child reply" },
        },
        makeClient
      );
      expect(parse).not.toHaveBeenCalled();
      expect(makeClient).not.toHaveBeenCalled();
      expect(appendJournalTurn).not.toHaveBeenCalled();
    }
  );
});
