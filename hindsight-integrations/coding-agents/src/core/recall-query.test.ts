import { afterEach, describe, expect, it, vi } from "vitest";
import { HindsightClient } from "./hindsight";
import { buildKnowledgeTools } from "./knowledge-tools";
import { parseRecallQuery, recallQueryShape, sanitizeRecallResponse } from "./recall-query";
import { toDshParameters, runDshTool } from "../dsh";
import { toPiTool } from "../harness/pi-extension";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const response = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
const result = {
  results: [
    {
      id: "higher",
      type: "world",
      text: "Specific source field.",
      scores: { final: 0.61, reranker: 0.51 },
    },
    {
      id: "lower",
      type: "experience",
      text: "Historical context.",
      scores: { final: 0.58, reranker: 0.91 },
    },
  ],
  chunks: { chunk: { chunk_text: "Original document paragraph.", chunk_index: 0 } },
  source_facts: {
    source: { id: "source", text: "Supporting evidence", mentioned_at: "2026-10-09T00:00:00Z" },
  },
  source_facts_truncated: true,
  trace: { query: { budget: 300 }, summary: { results_returned: 2 } },
};

describe("explicit memory queries", () => {
  it("keeps its deadline active while reading a stalled response body", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_url: unknown, init?: RequestInit) =>
          new Response(
            new ReadableStream({
              start(controller) {
                init?.signal?.addEventListener(
                  "abort",
                  () => controller.error(new Error("aborted response body")),
                  { once: true }
                );
                controller.enqueue(new TextEncoder().encode('{"results":['));
              },
            })
          )
      )
    );
    const task = new HindsightClient({ apiUrl: "http://fixture", bank: "project" }).queryMemories(
      parseRecallQuery({ query: "question" }, false)
    );
    const rejected = expect(task).rejects.toThrow("aborted response body");
    await vi.advanceTimersByTimeAsync(45000);
    await rejected;
  });

  it("rejects old-bank evidence when the mapping changes during response decoding", async () => {
    const root = mkdtempSync(join(tmpdir(), "hs-response-scope-"));
    const registry = join(root, "projects.json");
    writeFileSync(
      registry,
      JSON.stringify({ projects: [{ root, bankId: "project", enabled: true }] })
    );
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: unknown) =>
          String(url).endsWith("/stats")
            ? response({ bank_id: "project" })
            : new Response(
                new ReadableStream({
                  start(controller) {
                    setTimeout(() => {
                      writeFileSync(
                        registry,
                        JSON.stringify({ projects: [{ root, bankId: "other", enabled: true }] })
                      );
                      controller.enqueue(new TextEncoder().encode(JSON.stringify(result)));
                      controller.close();
                    }, 10);
                  },
                })
              )
        )
      );
      const client = new HindsightClient({
        apiUrl: "http://fixture",
        bank: "project",
        registryBinding: { directory: root, file: registry, networkConfigured: true },
      });
      await expect(
        client.queryMemories(parseRecallQuery({ query: "question" }, false))
      ).rejects.toThrow("project_scope_changed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("matches web defaults without inheriting automatic Recall settings", async () => {
    const fetch = vi.fn(async (_url: unknown, _init?: RequestInit) => response(result));
    vi.stubGlobal("fetch", fetch);
    const client = new HindsightClient({
      apiUrl: "http://fixture",
      bank: "project",
      recallOptions: { types: ["observation"], budget: "low", max_tokens: 2000 },
    });
    await client.queryMemories(parseRecallQuery({ query: "current question" }, false));
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({
      query: "current question",
      types: ["world", "experience"],
      budget: "mid",
      max_tokens: 4096,
    });
  });

  it("passes web filters and includes verbatim and preserves server rank, source data and trace", async () => {
    const fetch = vi.fn(async (_url: unknown, _init?: RequestInit) => response(result));
    vi.stubGlobal("fetch", fetch);
    const client = new HindsightClient({ apiUrl: "http://fixture", bank: "project" });
    const tool = buildKnowledgeTools(client, "project").find((t) => t.name === "hindsight_recall")!;
    const input = {
      query: "墒情主要字段是什么的",
      types: ["world"],
      budget: "mid",
      max_tokens: 4096,
      tags: ["tier:primary"],
      tags_match: "all_strict",
      query_timestamp: "2026-10-09T01:00:00Z",
      temporal_window: { start: "2026-09-01T00:00:00Z", end: "2026-10-09T00:00:00Z" },
      min_scores: { final: 0.1 },
      include: { chunks: { max_tokens: 1000 }, source_facts: { max_tokens: 2000 }, entities: null },
      trace: true,
      prefer_observations: false,
    };
    const output = await tool.handler(input);
    expect(output.isError).toBeFalsy();
    expect(JSON.parse(output.content[0].text)).toEqual({ result_count: 2, ...result });
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual(input);
    expect(String(fetch.mock.calls[0][0])).toBe(
      "http://fixture/v1/default/banks/project/memories/recall"
    );
  });

  it("pins observation type and includes its supporting facts by default", async () => {
    const fetch = vi.fn(async (_url: unknown, _init?: RequestInit) => response(result));
    vi.stubGlobal("fetch", fetch);
    const client = new HindsightClient({ apiUrl: "http://fixture", bank: "project" });
    const tool = buildKnowledgeTools(client, "project").find(
      (t) => t.name === "hindsight_search_observations"
    )!;
    expect(tool.annotations.readOnlyHint).toBe(true);
    await tool.handler({ query: "why this rule" }, { permission: "plan" });
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({
      types: ["observation"],
      include: { source_facts: { max_tokens: 2048 }, entities: null },
    });
    const bad = await tool.handler({ query: "question", types: ["world"] });
    expect(bad.isError).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("supports compound tag filters and searches all types when requested", () => {
    expect(
      parseRecallQuery(
        {
          query: "config",
          types: null,
          tag_groups: [
            { or: [{ tags: ["typescript"], resolve: "fuzzy" }, { not: { tags: ["deprecated"] } }] },
          ],
        },
        false
      )
    ).toMatchObject({ types: null, tag_groups: [{ or: expect.any(Array) }] });
  });

  it.each([
    { query: "" },
    { query: "???" },
    { query: "question", bank_id: "other" },
    { query: "question", max_tokens: 0 },
    { query: "question", max_tokens: 1.5 },
    { query: "question", budget: "unknown" },
    { query: "question", types: ["unknown"] },
    { query: "question", tags: [], tag_groups: [] },
    { query: "question", query_timestamp: "invalid" },
    { query: "question", temporal_window: { start: "2026-10-10", end: "2026-10-09" } },
  ])("rejects invalid input before performing a request: %j", async (input) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const tool = buildKnowledgeTools(
      new HindsightClient({ apiUrl: "http://fixture", bank: "project" }),
      "project"
    ).find((t) => t.name === "hindsight_recall")!;
    expect((await tool.handler(input)).isError).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not apply the automatic 2,000-token clipping to explicit results", async () => {
    const value = { results: [{ id: "long", text: "Source evidence paragraph. ".repeat(1800) }] };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response(value))
    );
    const tool = buildKnowledgeTools(
      new HindsightClient({ apiUrl: "http://fixture", bank: "project" }),
      "project"
    ).find((t) => t.name === "hindsight_recall")!;
    expect(JSON.parse((await tool.handler({ query: "source evidence" })).content[0].text)).toEqual({
      result_count: 1,
      ...value,
    });
  });

  it("returns an empty successful result distinctly from a request failure", async () => {
    const client = new HindsightClient({ apiUrl: "http://fixture", bank: "project" });
    const tool = buildKnowledgeTools(client, "project").find((t) => t.name === "hindsight_recall")!;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response({ results: [] }))
    );
    expect(JSON.parse((await tool.handler({ query: "missing" })).content[0].text)).toEqual({
      result_count: 0,
      results: [],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      })
    );
    await expect(runDshTool(tool, { query: "question" }, "plan")).rejects.toThrow("offline");
  });

  it("rejects a malformed API result instead of treating it as an empty bank", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response({ error: "bad response" }))
    );
    await expect(
      new HindsightClient({ apiUrl: "http://fixture", bank: "project" }).queryMemories(
        parseRecallQuery({ query: "question" }, false)
      )
    ).rejects.toThrow("invalid_memory_response");
  });

  it("removes credentials while preserving IDs, timestamps, metadata and evidence ordering", () => {
    const value = {
      results: [
        {
          id: "fact",
          text: "Bearer private-api-token",
          metadata: { password: "hidden", tier: "primary" },
          mentioned_at: "2026-10-09",
        },
      ],
      chunks: { c: { chunk_text: "api_key=hidden" } },
    };
    const clean = sanitizeRecallResponse(value, "private-api-token");
    expect(JSON.stringify(clean)).not.toMatch(/private-api-token|hidden/);
    expect(clean).toMatchObject({
      results: [{ id: "fact", metadata: { tier: "primary" }, mentioned_at: "2026-10-09" }],
    });
  });

  it("publishes the same typed options to DSH and Pi", () => {
    const tool = buildKnowledgeTools(
      new HindsightClient({ apiUrl: "http://fixture", bank: "project" }),
      "project"
    ).find((t) => t.name === "hindsight_recall")!;
    for (const schema of [toDshParameters(tool), toPiTool(tool).parameters]) {
      expect(schema.properties).toMatchObject({
        max_tokens: { type: "integer" },
        trace: { type: "boolean" },
        include: { type: "object" },
      });
      expect(schema.$defs ?? schema.definitions).toBeTruthy();
    }
    expect(Object.keys(recallQueryShape)).not.toContain("bank_id");
  });
});
