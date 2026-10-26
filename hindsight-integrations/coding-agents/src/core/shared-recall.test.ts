import { describe, expect, it, vi } from "vitest";
import { sharedRecall, outputTokens } from "./shared-recall";

const fact = (id: string, text: string, reranker = 0.9) => ({
  id,
  text,
  document_id: `doc-${id}`,
  mentioned_at: "2026-10-08T00:00:00Z",
  scores: { reranker },
});
const page = (id: string, name: string, body: string) => ({ id, name, body });
function fixture(facts: ReturnType<typeof fact>[], pages: ReturnType<typeof page>[]) {
  return {
    bank: "fixture",
    recallObservations: async () => facts.map((f) => f.text),
    recallCandidates: async () => facts,
    searchKnowledgePages: async () =>
      pages.map((p) => ({ id: p.id, name: p.name, score: 0.99, snippet: p.body.slice(0, 280) })),
    getPage: vi.fn(async (id: string) => pages.find((p) => p.id === id)),
  };
}

describe("shared recall content quality", () => {
  it("abstains when high-ranked pages contain no evidence about the question", async () => {
    const client = fixture(
      [],
      [
        page(
          "p",
          "Project overview",
          "# Overview\n\nThe billing project was documented in September.\n\n# Operations\n\nInvoices are exported daily."
        ),
      ]
    );
    const result = await sharedRecall(
      client,
      "How do satellite antennas handle cosmic radiation?",
      undefined,
      100
    );
    expect(result.text).toBe("");
    expect(client.getPage).toHaveBeenCalled();
    expect(result.diagnostics.rejected).toBeGreaterThan(0);
  });

  it.each([
    ["退款幂等如何实现", "退款规则", "退款请求通过幂等键识别；相同请求返回原收据，不重复扣款。"],
    [
      "How does the cache eviction policy work?",
      "Cache design",
      "The cache eviction policy removes the least recently used entry when capacity is reached.",
    ],
    ["物品标签如何管理", "物品管理", "物品标签可以同时绑定多个物品；删除标签不会删除物品记录。"],
    [
      "Why does the scheduler lease expire?",
      "Scheduler decisions",
      "The scheduler lease expires after a worker stops renewing it, so another worker can recover the job.",
    ],
  ])("extracts evidence from the body across topics: %s", async (query, title, evidence) => {
    const preamble = "历史资料整理日期和范围说明。".repeat(80);
    const client = fixture(
      [],
      [page("body", title, `# ${title}\n\n${preamble}\n\n## Rules\n\n${evidence}`)]
    );
    const result = await sharedRecall(client, query, undefined, 100);
    expect(result.text).toContain(evidence);
    expect(result.text).not.toContain(preamble);
    expect(result.items[0]).toMatchObject({ source: "knowledge", id: "body", title });
  });

  it("keeps semantic paraphrases even when the words do not match", async () => {
    const client = fixture(
      [
        fact(
          "semantic",
          "Persist an idempotency key and return the original receipt for duplicates."
        ),
      ],
      []
    );
    const result = await sharedRecall(
      client,
      "How are repeated submissions made safe?",
      undefined,
      100
    );
    expect(result.text).toContain("idempotency key");
    expect(result.items[0]).toMatchObject({
      id: "semantic",
      documentId: "doc-semantic",
      date: "2026-10-08T00:00:00Z",
    });
  });

  it("does not treat a very low semantic score as an automatic veto for an exact identifier", async () => {
    const client = fixture(
      [fact("literal", "tenant_uuid is the stable tenant identifier.", 0.001)],
      []
    );
    const result = await sharedRecall(client, "What is tenant_uuid?", undefined, 100);
    expect(result.text).toContain("stable tenant identifier");
  });

  it("rejects weak semantic results with no lexical evidence", async () => {
    const client = fixture([fact("wrong", "Invoices are exported daily.", 0.01)], []);
    const result = await sharedRecall(
      client,
      "What causes satellite antenna overheating?",
      undefined,
      100
    );
    expect(result.text).toBe("");
  });

  it("merges duplicate evidence while preserving both sources", async () => {
    const text = "The cache eviction policy removes the least recently used entry.";
    const client = fixture([fact("m", text)], [page("p", "Cache", `# Cache\n\n${text}`)]);
    const result = await sharedRecall(client, "What is the cache eviction policy?", undefined, 100);
    expect(result.items).toHaveLength(1);
    expect(JSON.stringify(result.items)).toContain('"id":"m"');
    expect(JSON.stringify(result.items)).toContain('"id":"p"');
    expect(result.diagnostics.duplicates).toBe(1);
  });

  it("keeps provenance labels outside the passage while preserving temporal attribution", async () => {
    const client = fixture(
      [
        fact(
          "record",
          "Request timeout is 5 seconds. | When: October 8, 2026 | Involving: Assistant | The value was measured in an isolated test."
        ),
      ],
      []
    );
    const result = await sharedRecall(client, "Request timeout", undefined, 100);
    expect(result.items[0].text).not.toContain("When:");
    expect(result.items[0].text).toContain("isolated test");
    expect(result.items[0].attribution).toContain("October 8, 2026");
  });

  it("preserves conflicting literal values rather than deduplicating them", async () => {
    const client = fixture(
      [fact("old", "Request timeout is 3 seconds."), fact("new", "Request timeout is 5 seconds.")],
      []
    );
    const result = await sharedRecall(client, "What is the request timeout?", undefined, 100);
    expect(result.text).toContain("3 seconds");
    expect(result.text).toContain("5 seconds");
  });

  it("preserves changed assignments when the same numbers occur in a different order", async () => {
    const client = fixture(
      [
        fact("a", "Request timeout is 3 seconds and retry limit is 5 attempts."),
        fact("b", "Request timeout is 5 seconds and retry limit is 3 attempts."),
      ],
      []
    );
    const result = await sharedRecall(
      client,
      "What are the request timeout and retry limit?",
      undefined,
      100
    );
    expect(result.items).toHaveLength(2);
  });

  it("keeps concrete semantic facts above generic descriptions repeating the topic words", async () => {
    const client = fixture(
      [
        fact(
          "generic",
          "Request timeout policy documentation references several historical records.",
          0.51
        ),
        fact("specific", "Upstream requests are cancelled after 5 seconds.", 0.93),
      ],
      []
    );
    const result = await sharedRecall(
      client,
      "What is the request timeout policy?",
      undefined,
      100
    );
    expect(result.items[0].id).toBe("specific");
  });

  it("segments Chinese queries without adding domain-specific expansion words", async () => {
    const searches = vi.fn(async (_query: string) => [fact("x", "库存标签可以绑定多个物品。")]);
    const client = { ...fixture([], []), recallCandidates: searches };
    const result = await sharedRecall(client, "库存标签是什么的", undefined, 100);
    expect(searches).toHaveBeenCalledTimes(2);
    expect(searches.mock.calls[1][0]).toBe("库存标签是什么的");
    expect(searches.mock.calls[0][0]).toMatch(/库存.*标签/);
    expect(result.text).toContain("可以绑定");
  });

  it.each([
    ["Request timeout is 3.5 seconds.", "Request timeout is 35 seconds."],
    ['Request value is "Foo".', 'Request value is "foo".'],
    ["Request is allowed when count == 1.", "Request is allowed when count != 1."],
  ])("preserves literal conflicts hidden by punctuation normalization: %s", async (a, b) => {
    const result = await sharedRecall(
      fixture([fact("a", a), fact("b", b)], []),
      "Request rule",
      undefined,
      100
    );
    expect(result.items).toHaveLength(2);
  });

  it("produces the same evidence ordering regardless of which retrieval arm finishes first", async () => {
    const build = (memoryFirst: boolean) => {
      const base = fixture(
        [fact("m", "Request timeout is 5 seconds.")],
        [page("p", "Timeout", "# Timeout\n\nRequest timeout cancels the upstream connection.")]
      );
      const delayed = <T>(value: T, delay: boolean) =>
        new Promise<T>((resolve) => setTimeout(() => resolve(value), delay ? 15 : 0));
      return {
        ...base,
        recallCandidates: () => delayed([fact("m", "Request timeout is 5 seconds.")], !memoryFirst),
        searchKnowledgePages: () =>
          delayed(
            [{ id: "p", name: "Timeout", snippet: "Request timeout", score: 1 }],
            memoryFirst
          ),
      };
    };
    const a = await sharedRecall(build(true), "What is the request timeout?", undefined, 100);
    const b = await sharedRecall(build(false), "What is the request timeout?", undefined, 100);
    expect(a.items).toEqual(b.items);
  });

  it("preserves a fast semantic result while a page read exceeds the shared deadline", async () => {
    const client = {
      ...fixture(
        [fact("fast", "Request timeout is 5 seconds.")],
        [page("slow", "Timeout", "Request timeout")]
      ),
      getPage: () => new Promise<never>(() => {}),
    };
    const started = Date.now();
    const result = await sharedRecall(client, "What is the request timeout?", undefined, 40);
    expect(result.text).toContain("5 seconds");
    expect(Date.now() - started).toBeLessThan(500);
    expect(result.diagnostics.timedOut).toBe(true);
  });

  it("does not return an unread page's unvalidated introductory snippet", async () => {
    const client = {
      ...fixture(
        [],
        [page("p", "Cache policy", "# Cache policy\n\nDocumentation coverage and source dates.")]
      ),
      getPage: async () => {
        throw new Error("offline");
      },
    };
    const result = await sharedRecall(client, "How are cache entries evicted?", undefined, 100);
    expect(result.text).toBe("");
    expect(result.diagnostics.pageFailures).toBe(1);
  });

  it("bounds injection tokens and preserves useful excerpts from oversized facts", async () => {
    const client = fixture(
      [
        fact(
          "huge",
          "Request timeout is 5 seconds. " +
            "Historical coverage and provenance notes. ".repeat(1000)
        ),
      ],
      []
    );
    const result = await sharedRecall(client, "What is the request timeout?", undefined, 100);
    expect(result.text).toContain("5 seconds");
    expect(outputTokens(result.text)).toBeLessThanOrEqual(2000);
  });

  it("never mutates returned diagnostics when a timed-out arm completes later", async () => {
    let finish!: (value: ReturnType<typeof fact>[]) => void;
    const client = {
      ...fixture([], []),
      recallCandidates: () =>
        new Promise<ReturnType<typeof fact>[]>((resolve) => {
          finish = resolve;
        }),
    };
    const result = await sharedRecall(client, "Request timeout", undefined, 20);
    const snapshot = JSON.stringify(result);
    finish([fact("late", "Request timeout is 5 seconds.")]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(JSON.stringify(result)).toBe(snapshot);
  });
});
