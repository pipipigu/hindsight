import { describe, expect, it } from "vitest";
import { formatRecallResponse } from "./recall-output";
import { parseRecallQuery, recallOutputFormat } from "./recall-query";

describe("compact Recall evidence", () => {
  const text =
    "A source paragraph.\n\nKeep formatting and literal values: timeout=0; enabled=false.\n";
  const payload = {
    result_count: 999,
    results: [
      {
        id: "m1",
        text,
        type: "observation",
        mentioned_at: "2026-10-09T00:00:00Z",
        occurred_start: null,
        context: null,
        scores: { final: 0.9 },
        document_id: "internal-doc",
        chunk_id: "chunk-key",
        tags: ["tier:reference", "source:wiki", "topic:0123456789abcdef"],
        metadata: {
          source_path: "guide.md",
          source_key: "guide.md",
          source_sha256: "hash",
          tier: "reference",
          verified: false,
          version: 0,
          source_agent_id: "agent-internal",
          generated_type: "entity_summary",
          source_layer: "L2",
          document_status: "proposal",
          source: "explicit_save",
          evidence: "Fixture deployment receipt",
          limitations: { scope: "Single fixture; not a global guarantee" },
        },
        source_fact_ids: ["fact-a", "fact-b"],
      },
      {
        id: "m2",
        text: "Second conclusion",
        source_fact_ids: ["fact-a", "missing", "constructor"],
        attachments: [],
        metadata: {},
      },
    ],
    source_facts: {
      "fact-a": {
        id: "fact-a",
        text: "First source",
        tags: ["tier:primary"],
        scores: { final: 0.7 },
      },
      "fact-b": {
        id: "fact-b",
        text: "Second source",
        context: "Historical source; verify against current code",
      },
    },
    chunks: { "chunk-key": { chunk_text: text, chunk_index: 0, truncated: false } },
    trace: { internal: "debug only" },
    entities: null,
    source_facts_truncated: true,
  };

  it("keeps every result in server order and leaves its text and dates unchanged", () => {
    const compact = formatRecallResponse(payload, "compact");
    expect(compact.result_count).toBe(2);
    expect(compact.results).toMatchObject([
      { id: "m1", text, mentioned_at: "2026-10-09T00:00:00Z" },
      { id: "m2", text: "Second conclusion" },
    ]);
    expect(JSON.stringify(payload)).toContain("internal-doc");
    expect(JSON.stringify(compact)).not.toMatch(
      /internal-doc|source_sha256|occurred_start|"scores"|"trace"|topic:0123456789abcdef/
    );
    expect((compact.results as Record<string, unknown>[])[0].metadata).toEqual({
      source_path: "guide.md",
      tier: "reference",
      verified: false,
      version: 0,
      document_status: "proposal",
      source: "explicit_save",
      evidence: "Fixture deployment receipt",
      limitations: { scope: "Single fixture; not a global guarantee" },
    });
    expect(JSON.stringify(compact)).not.toMatch(/agent-internal|entity_summary|source_layer/);
  });

  it("uses one shared source table and keeps missing evidence explicit", () => {
    const compact = formatRecallResponse(payload, "compact");
    expect(compact.results).toMatchObject([
      { source_refs: ["F1", "F2"] },
      { source_refs: ["F1"], missing_source_count: 2 },
    ]);
    expect(compact.sources).toEqual({
      F1: { id: "fact-a", text: "First source", tags: ["tier:primary"] },
      F2: {
        id: "fact-b",
        text: "Second source",
        context: "Historical source; verify against current code",
      },
    });
    expect(compact.missing_source_count).toBe(2);
    expect(compact.source_facts_truncated).toBe(true);
  });

  it("keeps requested raw chunks connected to their memory and preserves false/zero", () => {
    const compact = formatRecallResponse(payload, "compact");
    expect(compact.results).toMatchObject([{ chunk_ref: "C1" }, {}]);
    expect(compact.chunks).toEqual({ C1: { chunk_text: text, chunk_index: 0, truncated: false } });
    expect(formatRecallResponse({ results: [], source_facts_truncated: false }, "compact")).toEqual(
      { result_count: 0, results: [], source_facts_truncated: false }
    );
  });

  it("hides entity information by default and returns it on explicit request or in raw mode", () => {
    const payload = {
      results: [{ id: "x", text: "Robert renewed the lease", entities: ["Robert Smith"] }],
      entities: {
        "Robert Smith": { observations: [{ text: "Maintains the worker", context: null }] },
      },
    };
    expect(formatRecallResponse(payload, "compact")).toEqual({
      result_count: 1,
      results: [{ id: "x", text: "Robert renewed the lease" }],
    });
    const v = formatRecallResponse(payload, "compact", { includeEntities: true });
    expect(v).toMatchObject({
      results: [{ entities: ["Robert Smith"] }],
      entities: { "Robert Smith": { observations: [{ text: "Maintains the worker" }] } },
    });
    expect(formatRecallResponse(payload, "raw")).toEqual({ result_count: 1, ...payload });
  });

  it("returns full raw API data on demand, including empty/debug fields", () => {
    expect(formatRecallResponse(payload, "raw")).toEqual({ ...payload, result_count: 2 });
  });

  it("does not change array positions even for unexpected result shapes", () => {
    expect(
      formatRecallResponse({ results: [null, "record", { id: "x", text: "" }] }, "compact")
    ).toEqual({ result_count: 3, results: [null, "record", { id: "x" }] });
  });

  it("does not send output formatting to the public Recall API", () => {
    for (const output_format of ["compact", "raw"] as const) {
      const input = { query: "question", output_format, max_tokens: 4096, trace: true };
      expect(parseRecallQuery(input, false)).toEqual({
        query: "question",
        types: ["world", "experience"],
        budget: "mid",
        max_tokens: 4096,
        trace: true,
        include: { entities: null },
      });
      expect(recallOutputFormat(input)).toBe(output_format);
    }
    expect(recallOutputFormat({ query: "question" })).toBe("compact");
    expect(recallOutputFormat({ query: "question", trace: true })).toBe("raw");
    expect(() =>
      parseRecallQuery({ query: "question", output_format: "invalid" }, false)
    ).toThrow();
  });
});
