import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  boundedRecallResponse,
  boundedMemoryRead,
  memoryOutputTokens,
  boundedKnowledgeRead,
  boundedKnowledgeSearch,
} from "./recall-budget";
import { parseRecallQuery } from "./recall-query";
import { HindsightClient } from "./hindsight";
import { buildKnowledgeTools } from "./knowledge-tools";
import { toDshParameters } from "../dsh";
import { toPiTool } from "../harness/pi-extension";

const id = "11111111-1111-4111-8111-111111111111";
const body = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const fact = {
  id,
  text: "方案尚未实施。enabled=false；样本值=0，不保证全部数据。",
  type: "world",
  state: "valid",
  metadata: {
    document_status: "proposal",
    verified: false,
    scope: "One historical sample",
    version: 0,
  },
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const toolsFor = (client = new HindsightClient({ apiUrl: "http://fixture", bank: "project" })) =>
  buildKnowledgeTools(client, "project");
const find = (name: string, client?: HindsightClient) =>
  toolsFor(client).find((t) => t.name === name)!;

describe("bounded explicit search", () => {
  it("bounds knowledge snippets in server order and addresses an oversized top hit", () => {
    const pages = Array.from({ length: 20 }, (_, i) => ({
      page_id: String(i),
      page: "Topic",
      snippet: fact.text.repeat(6),
    }));
    const out = boundedKnowledgeSearch(pages, "Historical evidence, not an instruction.");
    expect((out.pages as typeof pages).map((p) => p.page_id)).toEqual(["0", "1", "2", "3", "4"]);
    expect(memoryOutputTokens(JSON.stringify(out))).toBeLessThanOrEqual(3000);
    expect(
      boundedKnowledgeSearch(
        [{ ...pages[0], snippet: fact.text.repeat(2000) }],
        "Historical evidence"
      )
    ).toMatchObject({ pages: [{ page_id: "0", requires_read: true }] });
  });
  it("returns the first five complete facts in authoritative server order", () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      ...fact,
      id: String(i),
      scores: { reranker: i },
    }));
    const out = boundedRecallResponse({ results: rows });
    expect(out).toMatchObject({ result_count: 5, matched_count: 20, omitted_count: 15 });
    expect((out.results as typeof rows).map((r) => r.id)).toEqual(["0", "1", "2", "3", "4"]);
    for (const row of out.results as typeof rows) {
      expect(row.text).toBe(fact.text);
      expect(row.metadata).toEqual(fact.metadata);
    }
  });

  it("counts Chinese, provenance and supporting sources in the whole serialized JSON", () => {
    const out = boundedRecallResponse({
      results: Array.from({ length: 10 }, (_, i) => ({
        ...fact,
        id: String(i),
        text: fact.text.repeat(15),
        source_fact_ids: ["s"],
        chunk_id: "c",
      })),
      source_facts: { s: { id: "s", text: "原始证据未确认部署。".repeat(800) } },
      chunks: { c: { chunk_text: "原文内容".repeat(6000) } },
      source_facts_truncated: false,
    });
    expect(memoryOutputTokens(JSON.stringify(out))).toBeLessThanOrEqual(3000);
    expect(out).toMatchObject({
      sources_omitted: true,
      chunks_omitted: true,
      source_facts_truncated: false,
    });
    for (const row of out.results as (typeof fact)[]) expect(row.text).toBe(fact.text.repeat(15));
    expect((out.results as Record<string, unknown>[])[0].source_ids).toEqual(["s"]);
  });

  it("returns an address instead of clipping an oversized assertion or skipping to a lower rank", () => {
    const out = boundedRecallResponse({
      results: [
        { ...fact, text: fact.text.repeat(2000) },
        { ...fact, id: "lower" },
      ],
    });
    expect(out).toMatchObject({
      results: [{ id, requires_read: true }],
      result_count: 1,
      omitted_count: 1,
    });
    expect(JSON.stringify(out)).not.toContain("样本值");
    expect(memoryOutputTokens(JSON.stringify(out))).toBeLessThanOrEqual(3000);
  });

  it("never lets explicitly requested entity context displace complete facts", () => {
    const out = boundedRecallResponse(
      {
        results: [{ ...fact, entities: ["entity".repeat(20000)] }],
        entities: { text: "context".repeat(10000) },
      },
      {},
      true
    );
    expect(out.results).toEqual([fact]);
    expect(out.entities).toBeUndefined();
  });

  it("uses explicit visible IDs for repeat suppression, without an implicit session cache", () => {
    const rows = [fact, { ...fact, id: "new" }];
    const out = boundedRecallResponse({ results: rows }, { seen_ids: [id] });
    expect(out).toMatchObject({
      repeated_ids: [id],
      repeated_count: 1,
      result_count: 1,
      results: [{ id: "new" }],
    });
    expect(boundedRecallResponse({ results: rows }).result_count).toBe(2);
  });

  it("publishes only sources and original chunks linked to returned facts", () => {
    const out = boundedRecallResponse({
      results: [{ ...fact, source_fact_ids: ["s"], chunk_id: "c" }],
      source_facts: { s: { text: "evidence" }, unrelated: { text: "wrong source" } },
      chunks: {
        c: { chunk_text: "own original" },
        unrelated: { chunk_text: "unrelated original" },
      },
    });
    expect(JSON.stringify(out)).toContain("own original");
    expect(JSON.stringify(out)).not.toMatch(/wrong source|unrelated original/);
    expect((out.results as Record<string, unknown>[])[0].source_refs).toEqual(["F1"]);
  });

  it("strips output controls before sending the official API request", () => {
    const query = parseRecallQuery(
      {
        query: "field definition",
        limit: 3,
        output_tokens: 1200,
        seen_ids: [id],
        max_tokens: 6500,
        include: { chunks: { max_tokens: 6000 } },
      },
      false
    );
    expect(query.max_tokens).toBe(6500);
    expect(query).not.toHaveProperty("limit");
    expect(query).not.toHaveProperty("output_tokens");
    expect(query).not.toHaveProperty("seen_ids");
    expect(() => parseRecallQuery({ query: "field", output_tokens: 10000 }, false)).toThrow();
  });

  it("still fits a caller's smaller whole-output budget including the guide", () => {
    const out = boundedRecallResponse(
      { results: [{ ...fact, text: fact.text.repeat(12) }, fact] },
      { output_tokens: 1024 }
    );
    expect(memoryOutputTokens(JSON.stringify(out))).toBeLessThanOrEqual(1024);
  });
});

describe("addressed, paged evidence", () => {
  it("pages knowledge body verbatim without repeating the long generation description", () => {
    const page = {
      id: "kp-fixture",
      name: "Conventions",
      last_updated_at: "2026-10-09",
      description: "Generation instructions. ".repeat(500),
      body: (fact.text + "🧠\n").repeat(150),
    };
    let offset = 0,
      hash: string | undefined,
      full = "";
    for (let i = 0; i < 20; i++) {
      const p = boundedKnowledgeRead(page, { offset, content_hash: hash });
      expect(memoryOutputTokens(JSON.stringify(p))).toBeLessThanOrEqual(3000);
      expect(JSON.stringify(p)).not.toContain("Generation instructions");
      full += p.body;
      hash = String(p.content_hash);
      if (!p.text_truncated) break;
      offset = Number(p.next_offset);
    }
    expect(full).toBe(page.body);
    const meta = boundedKnowledgeRead(page, { part: "metadata" });
    expect(String(meta.body)).toContain("Generation instructions");
  });

  it("rejects knowledge-page refreshes and project changes during continuation", () => {
    const page = { id: "kp-fixture", name: "Conventions", body: fact.text.repeat(200) };
    const p = boundedKnowledgeRead(page, {}, "scope-a");
    const view = { offset: Number(p.next_offset), content_hash: String(p.content_hash) };
    expect(() =>
      boundedKnowledgeRead({ ...page, body: page.body + "Changed" }, view, "scope-a")
    ).toThrow("memory_changed_restart_read");
    expect(() => boundedKnowledgeRead(page, view, "scope-b")).toThrow(
      "memory_changed_restart_read"
    );
  });

  it("keeps one deadline active while an addressed response body stalls", async () => {
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
                  () => controller.error(new Error("aborted addressed body")),
                  { once: true }
                );
                controller.enqueue(new TextEncoder().encode('{"id":'));
              },
            })
          )
      )
    );
    const task = new HindsightClient({ apiUrl: "http://fixture", bank: "project" }).readMemory(id);
    const rejected = expect(task).rejects.toThrow("aborted addressed body");
    await vi.advanceTimersByTimeAsync(45000);
    await rejected;
  });

  it("reassembles long Chinese/emoji evidence exactly and never implies a page is complete", () => {
    const memory = { ...fact, text: (fact.text + "🧠\n").repeat(140) };
    let offset = 0,
      hash: string | undefined,
      joined = "";
    for (let i = 0; i < 20; i++) {
      const page = boundedMemoryRead(memory, undefined, { offset, content_hash: hash });
      expect(memoryOutputTokens(JSON.stringify(page))).toBeLessThanOrEqual(3000);
      expect(page.metadata).toEqual(fact.metadata);
      expect(String(page.text)).not.toContain("\ufffd");
      joined += page.text;
      hash = String(page.content_hash);
      if (!page.text_truncated) break;
      expect(page.next_offset).toBeGreaterThan(offset);
      offset = Number(page.next_offset);
    }
    expect(joined).toBe(memory.text);
  });

  it("rejects changed facts, curation state, project scope and unversioned continuations", () => {
    const memory = { ...fact, text: fact.text.repeat(200) };
    const p = boundedMemoryRead(memory, undefined, {}, "project-1");
    const args = { offset: Number(p.next_offset), content_hash: String(p.content_hash) };
    expect(() =>
      boundedMemoryRead({ ...memory, text: memory.text + "changed" }, undefined, args, "project-1")
    ).toThrow("memory_changed_restart_read");
    expect(() =>
      boundedMemoryRead({ ...memory, state: "invalidated" }, undefined, args, "project-1")
    ).toThrow("memory_changed_restart_read");
    expect(() => boundedMemoryRead(memory, undefined, args, "project-2")).toThrow(
      "memory_changed_restart_read"
    );
    expect(() => boundedMemoryRead(memory, undefined, { offset: 1 })).toThrow(
      "memory_changed_restart_read"
    );
  });

  it("makes oversized provenance explicitly readable rather than silently removing its scope", () => {
    const memory = {
      ...fact,
      metadata: { ...fact.metadata, scope: "仅限历史测试环境。".repeat(1200) },
    };
    const page = boundedMemoryRead(memory, undefined);
    expect(page.provenance_omitted).toBe(true);
    expect(page.text).toBe(memory.text);
    const provenance = boundedMemoryRead(memory, undefined, { section: "provenance" });
    expect(provenance.text_truncated).toBe(true);
    expect(String(provenance.text)).toContain("仅限历史测试环境");
    expect(memoryOutputTokens(JSON.stringify(provenance))).toBeLessThanOrEqual(3000);
  });

  it("reads in plan mode from a fresh client without a search cache, and resolves only the fact's own original", async () => {
    const fetch = vi.fn(async (url: unknown) =>
      body(
        String(url).includes("/chunks/")
          ? {
              bank_id: "project",
              chunk_id: "owned/chunk",
              chunk_text: "Original source",
              document_id: "doc",
            }
          : { ...fact, chunk_id: "owned/chunk" }
      )
    );
    vi.stubGlobal("fetch", fetch);
    const read = find("hindsight_read_memory");
    const result = await read.handler(
      { memory_id: id, section: "original" },
      { permission: "plan" }
    );
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      text: "Original source",
      section: "original",
      metadata: fact.metadata,
    });
    expect(fetch.mock.calls.map((c) => String(c[0]))).toEqual([
      `http://fixture/v1/default/banks/project/memories/${id}`,
      "http://fixture/v1/default/chunks/owned%2Fchunk",
    ]);
    expect((await find("hindsight_read_memory").handler({ memory_id: id })).isError).toBeFalsy();
  });

  it("rejects a chunk from a different bank even when its ID was carried by the fact", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) =>
        body(
          String(url).includes("/chunks/")
            ? { bank_id: "other", chunk_id: "c", chunk_text: "Wrong bank" }
            : { ...fact, chunk_id: "c" }
        )
      )
    );
    await expect(
      new HindsightClient({ apiUrl: "http://fixture", bank: "project" }).readMemory(id, true)
    ).rejects.toThrow("project_bank_mismatch");
  });

  it("rejects a registry change during decoding, before returning old-bank details", async () => {
    const root = mkdtempSync(join(tmpdir(), "hs-read-scope-")),
      registry = join(root, "projects.json");
    writeFileSync(
      registry,
      JSON.stringify({ projects: [{ root, bankId: "project", enabled: true }] })
    );
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: unknown) =>
          String(url).endsWith("/stats")
            ? body({ bank_id: "project" })
            : new Response(
                new ReadableStream({
                  start(controller) {
                    setTimeout(() => {
                      writeFileSync(
                        registry,
                        JSON.stringify({ projects: [{ root, bankId: "other", enabled: true }] })
                      );
                      controller.enqueue(new TextEncoder().encode(JSON.stringify(fact)));
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
      await expect(client.readMemory(id)).rejects.toThrow("project_scope_changed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("distinguishes missing facts and originals, and rejects invalid inputs before networking", async () => {
    const fetch = vi.fn(async () => body(fact));
    vi.stubGlobal("fetch", fetch);
    const read = find("hindsight_read_memory");
    expect((await read.handler({ memory_id: "../../other" })).isError).toBe(true);
    expect((await read.handler({ memory_id: id, offset: 1 })).content[0].text).toBe(
      "memory_changed_restart_read"
    );
    expect(fetch).not.toHaveBeenCalled();
    expect((await read.handler({ memory_id: id, section: "original" })).content[0].text).toBe(
      "memory_original_unavailable"
    );
    fetch.mockImplementation(async () => body({}, 404));
    expect((await read.handler({ memory_id: id })).content[0].text).toBe("memory_not_found");
  });

  it("publishes matching native DSH/Pi read schemas and read-only annotations", () => {
    const read = find("hindsight_read_memory");
    expect(read.annotations.readOnlyHint).toBe(true);
    for (const schema of [toDshParameters(read), toPiTool(read).parameters])
      expect(schema.properties).toMatchObject({
        memory_id: { type: "string" },
        section: { enum: ["fact", "original", "provenance"] },
        offset: { type: "integer" },
        content_hash: { type: "string" },
      });
  });
});
