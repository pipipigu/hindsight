import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveConfig } from "./config";
import type { HindsightClient } from "./hindsight";
import { RuntimeCore } from "./runtime";

const pendingQueue = vi.hoisted(() => ["already-pending-conclusion"]);
const dispatched = vi.hoisted(() => [] as string[]);
const retrySpy = vi.hoisted(() =>
  vi.fn(async () => {
    dispatched.push(...pendingQueue);
    pendingQueue.splice(0);
  })
);
vi.mock("./conclusions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./conclusions")>()),
  retryConclusions: retrySpy,
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  retrySpy.mockClear();
  pendingQueue.splice(0, pendingQueue.length, "already-pending-conclusion");
  dispatched.splice(0);
});

describe("RuntimeCore read-only memory access", () => {
  it("does not resume already-pending conclusions on construction, timer, or manual resume", async () => {
    vi.useFakeTimers();
    vi.stubEnv("HINDSIGHT_MEMORY_ACCESS", "");
    const cfg = { ...resolveConfig({}), bankResolution: "registry" as const };
    const core = new RuntimeCore(
      { bindCancellation: vi.fn() } as unknown as HindsightClient,
      "bank-1",
      cfg,
      "dsh",
      "/repo",
      "read-only"
    );

    await core.resumeConclusions();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(retrySpy).not.toHaveBeenCalled();
    expect(dispatched).toEqual([]);
    core.dispose();
  });

  it("skips session-start seeding and shared-page writes, while retaining read tools", async () => {
    vi.stubEnv("HINDSIGHT_MEMORY_ACCESS", "");
    const seedPages = vi.fn(async () => {});
    const registryCore = new RuntimeCore(
      { seedPages, bindCancellation: vi.fn() } as unknown as HindsightClient,
      "bank-1",
      { ...resolveConfig({}), bankResolution: "registry" as const },
      "dsh",
      "/repo",
      "read-only"
    );
    await registryCore.seedIfCold("/repo");
    await registryCore.prepareSharedPages("normal");
    expect(seedPages).not.toHaveBeenCalled();
    registryCore.dispose();

    const queryMemories = vi.fn(async () => ({ results: [] }));
    const client = { queryMemories } as unknown as HindsightClient;
    const core = new RuntimeCore(
      client,
      "bank-1",
      resolveConfig({ bankResolution: "upstream" }),
      "dsh",
      "/repo",
      "read-only"
    );

    const tools = core.toolSpecs();
    expect(tools.some((tool) => tool.name === "hindsight_recall")).toBe(true);
    expect(tools.some((tool) => tool.name === "hindsight_ingest_document")).toBe(false);
    const recall = tools.find((tool) => tool.name === "hindsight_recall");
    await recall?.handler({ query: "test" });
    expect(queryMemories).toHaveBeenCalledTimes(1);
    core.dispose();
  });

  it("does not write session transcripts, including idle flushes", async () => {
    vi.stubEnv("HINDSIGHT_MEMORY_ACCESS", "");
    const retain = vi.fn(async () => {});
    const core = new RuntimeCore(
      { retain, bindCancellation: vi.fn() } as unknown as HindsightClient,
      "bank-1",
      resolveConfig({ bankResolution: "upstream" }),
      "dsh",
      "/repo",
      "read-only"
    );
    core.setTranscriptSource(async () => [{ role: "user", content: "secret" }] as never);

    await core.onTranscript("session-1", [{ role: "user", content: "secret" }] as never, true);
    await core.onSessionIdle("session-1");
    expect(retain).not.toHaveBeenCalled();
    core.dispose();
  });
});
