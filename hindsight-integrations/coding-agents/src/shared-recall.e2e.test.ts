import { afterEach, expect, it, vi } from "vitest";
import { resolveHostMemory } from "./core/host-client";
import { sharedRecall, outputTokens } from "./core/shared-recall";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { sanitizeSharedText } from "./core/shared-sanitize";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it.skipIf(process.env.HINDSIGHT_RECALL_LIVE !== "1")(
  "validates cross-topic recall against the configured service using read-only requests",
  async () => {
    vi.stubEnv(
      "HINDSIGHT_CONFIG",
      process.env.HINDSIGHT_RECALL_LIVE_CONFIG || join(homedir(), ".hindsight", "coding-agent.json")
    );
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? "GET",
        path = new URL(String(url)).pathname;
      if (method !== "GET" && !(method === "POST" && path.endsWith("/memories/recall")))
        throw new Error("live_recall_test_readonly");
      return originalFetch(url, init);
    });
    const cases = [
      {
        directory: "/home/ppz/project/ybd/SQ",
        query: "墒情主要字段是什么的",
        expected: /soil_saturation|监测指标|\bvalue\b/,
        positive: true,
      },
      {
        directory: "/home/ppz/project/ybd/SQ",
        query: "共享站的监测记录里存了哪些信息",
        expected: /共享站|监测记录/,
        positive: true,
      },
      {
        directory: "/home/ppz/project/dsh",
        query: "记忆插件为什么按项目隔离",
        expected: /项目|workspace|bank/i,
        positive: true,
      },
      {
        directory: "/home/ppz/project/ybd/SQ",
        query: "火星居留许可与星舰通行凭证如何校验",
        positive: false,
      },
      {
        directory: "/home/ppz/project/dsh",
        query: "How does lunar regolith crystallize under neutron flux?",
        positive: false,
      },
    ];
    const observations: unknown[] = [];
    for (const fixture of cases) {
      const memory = resolveHostMemory("dsh", fixture.directory);
      expect(memory.cfg.disabled).toBe(false);
      const backend: unknown[] = [];
      const recall = memory.client.recallCandidates.bind(memory.client);
      memory.client.recallCandidates = async (query, options) => {
        const rows = await recall(query, options);
        backend.push({
          query,
          rows: rows.map((row) => ({
            id: row.id,
            text: sanitizeSharedText(row.text, [memory.client.apiToken]),
            scores: row.scores,
          })),
        });
        return rows;
      };
      const result = await sharedRecall(memory.client, fixture.query, undefined, 7000);
      observations.push({
        backend,
        query: fixture.query,
        bank: memory.bankId,
        items: result.items,
        diagnostics: result.diagnostics,
        tokens: outputTokens(result.text),
      });
      if (process.env.HINDSIGHT_RECALL_LIVE_OUTPUT)
        writeFileSync(
          process.env.HINDSIGHT_RECALL_LIVE_OUTPUT,
          JSON.stringify(observations, null, 2),
          { mode: 0o600 }
        );
      console.log(
        JSON.stringify({
          query: fixture.query,
          bank: memory.bankId,
          items: result.items.map((x) => ({
            source: x.source,
            id: x.id,
            title: x.title,
            section: x.section,
            excerpt: x.text.slice(0, 160),
          })),
          diagnostics: result.diagnostics,
        })
      );
      expect(result.diagnostics.ms).toBeLessThan(7250);
      expect(outputTokens(result.text)).toBeLessThanOrEqual(2000);
      if (fixture.positive) {
        expect(result.text).toMatch(fixture.expected!);
        expect(result.items.every((x) => x.id)).toBe(true);
      } else {
        expect(result.text).toBe("");
        expect(result.diagnostics.outcome).toBe("filtered");
        expect(result.diagnostics.received).toBeGreaterThan(0);
      }
    }
  },
  60000
);
