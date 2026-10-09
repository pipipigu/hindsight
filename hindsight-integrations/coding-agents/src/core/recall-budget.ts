import { createHash } from "node:crypto";
import { Tiktoken } from "js-tiktoken/lite";
import cl100k from "js-tiktoken/ranks/cl100k_base";
import { formatRecallResponse } from "./recall-output";
import { MEMORY_RESULT_GUIDE } from "./recall-guidance";
import type { RecallView } from "./recall-query";

type Row = Record<string, unknown>;
const rowOf = (v: unknown): Row =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {};
const idsOf = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((id): id is string => typeof id === "string") : [];
export const DEFAULT_MEMORY_OUTPUT_TOKENS = 3000;
let encoder: Tiktoken | undefined;
const tokenCounts = new Map<string, number>();

/** Bounded-size tokenization avoids quadratic BPE work on long unbroken historical text.
 * Segment-boundary and framing margins make this a conservative estimate, not provider usage. */
export function memoryOutputTokens(text: string, stopAfter = Infinity): number {
  encoder ??= new Tiktoken(cl100k);
  const chars = Array.from(text);
  let tokens = 32;
  for (let i = 0; i < chars.length; i += 256) {
    const part = chars.slice(i, i + 256).join("");
    let count = tokenCounts.get(part);
    if (count === undefined) {
      count = encoder.encode(part, [], []).length;
      if (tokenCounts.size >= 1024) tokenCounts.delete(tokenCounts.keys().next().value!);
      tokenCounts.set(part, count);
    }
    tokens += count + 2;
    if (tokens > stopAfter) return tokens;
  }
  return tokens;
}
const fits = (value: Row, budget: number) => {
  const text = JSON.stringify(value);
  // Avoid spending seconds tokenizing an adversarially oversized record just to reject it.
  return text.length <= budget * 16 && memoryOutputTokens(text, budget) <= budget;
};

/** Keep complete facts in server order. Extras share the same budget and never outrank facts. */
export function boundedRecallResponse(
  payload: Row,
  view: RecallView = {},
  includeEntities = false
): Row {
  const all = payload.results as unknown[];
  const seen = new Set(view.seen_ids ?? []);
  const repeated = all.filter((r) => seen.has(String(rowOf(r).id)));
  const candidates = all.filter((r) => !seen.has(String(rowOf(r).id)));
  const selected: unknown[] = [];
  const sources: Row = Object.create(null),
    chunks: Row = Object.create(null);
  const sourcePool = rowOf(payload.source_facts),
    chunkPool = rowOf(payload.chunks);
  const budget = view.output_tokens ?? DEFAULT_MEMORY_OUTPUT_TOKENS;
  let entityContext: unknown;
  let entityRows = false;
  const envelope = (): Row => ({
    evidence_guidance: MEMORY_RESULT_GUIDE,
    ...formatRecallResponse(
      { ...payload, results: selected, source_facts: sources, chunks, entities: entityContext },
      "compact",
      { includeEntities: entityRows }
    ),
    matched_count: all.length,
    omitted_count: candidates.length - selected.length,
    ...(repeated.length
      ? {
          repeated_ids: repeated.slice(0, 5).map((r) => rowOf(r).id),
          repeated_count: repeated.length,
        }
      : {}),
    ...(Object.keys(sourcePool).length > Object.keys(sources).length
      ? { sources_omitted: true }
      : {}),
    ...(Object.keys(chunkPool).length > Object.keys(chunks).length ? { chunks_omitted: true } : {}),
  });

  for (const r of candidates.slice(0, view.limit ?? 5)) {
    selected.push(r);
    if (fits(envelope(), budget)) continue;
    selected.pop();
    if (!selected.length) {
      const id = rowOf(r).id;
      if (typeof id !== "string" || id.length > 128) throw new Error("invalid_memory_response");
      // A shortened assertion could lose its scope or negation. Return an address, not an excerpt.
      selected.push({ id, requires_read: true });
    }
    break;
  }
  // The formatter deliberately only publishes known fields, so restore address-only markers.
  const withMarkers = (): Row => {
    const out = envelope();
    const rows = out.results as Row[];
    selected.forEach((r, i) => {
      if (rowOf(r).requires_read) rows[i].requires_read = true;
    });
    return out;
  };

  const pending = selected.flatMap((r) => idsOf(rowOf(r).source_fact_ids));
  const visited = new Set<string>();
  for (let i = 0; i < pending.length && visited.size < 100; i++) {
    const id = pending[i];
    if (visited.has(id)) continue;
    visited.add(id);
    if (!Object.hasOwn(sourcePool, id)) continue;
    sources[id] = sourcePool[id];
    if (!fits(withMarkers(), budget)) delete sources[id];
    else pending.push(...idsOf(rowOf(sourcePool[id]).source_fact_ids));
  }
  // Only the originals linked to returned facts may enter the response, and only on request.
  for (const r of selected) {
    const id = rowOf(r).chunk_id;
    if (typeof id !== "string" || !Object.hasOwn(chunkPool, id)) continue;
    chunks[id] = chunkPool[id];
    if (!fits(withMarkers(), budget)) delete chunks[id];
  }
  if (includeEntities) {
    entityRows = true;
    if (!fits(withMarkers(), budget)) entityRows = false;
    entityContext = payload.entities;
    if (!fits(withMarkers(), budget)) entityContext = undefined;
  }
  const out = withMarkers();
  if (!fits(out, budget)) throw new Error("memory_output_budget_exceeded");
  return out;
}

export interface MemoryReadView {
  section?: "fact" | "original" | "provenance";
  offset?: number;
  content_hash?: string;
  output_tokens?: number;
}

/** Page one fact or its own original by Unicode code points, with a versioned continuation. */
export function boundedMemoryRead(
  memory: Row,
  original: Row | undefined,
  view: MemoryReadView = {},
  scope = ""
): Row {
  const section = view.section ?? "fact";
  const projected = (formatRecallResponse({ results: [memory] }, "compact").results as Row[])[0];
  const { text: _text, ...provenance } = projected;
  for (const key of ["document_id", "chunk_id", "observation_scopes"])
    if (memory[key] != null && memory[key] !== "") provenance[key] = memory[key];
  const sourceIds = [
    ...new Set([
      ...idsOf(memory.source_fact_ids),
      ...idsOf(memory.source_memory_ids),
      ...(Array.isArray(memory.source_facts)
        ? memory.source_facts
            .map((r) => rowOf(r).id)
            .filter((id): id is string => typeof id === "string")
        : []),
    ]),
  ];
  if (sourceIds.length) provenance.source_ids = sourceIds;
  const text =
    section === "provenance"
      ? JSON.stringify(provenance)
      : section === "original"
        ? String(original?.chunk_text ?? original?.text ?? "")
        : String(memory.text ?? "");
  const hash = createHash("sha256")
    .update(JSON.stringify([scope, memory.id, section, text, provenance]))
    .digest("hex");
  return pagedEvidence(
    text,
    view,
    hash,
    {
      ...(section === "provenance" ? { id: memory.id } : provenance),
      section,
      ...(section === "original"
        ? { chunk_id: original?.chunk_id, document_id: original?.document_id }
        : {}),
    },
    { id: memory.id, state: memory.state, section, provenance_omitted: true },
    "text"
  );
}

export type KnowledgeReadView = Omit<MemoryReadView, "section"> & { part?: "body" | "metadata" };

/** Keep complete ranked snippets; generation prompts belong to an explicit metadata read. */
export function boundedKnowledgeSearch(pages: Row[], crediting: string): Row {
  const selected: Row[] = [];
  const envelope = () => ({
    pages: selected,
    crediting,
    matched_count: pages.length,
    omitted_count: pages.length - selected.length,
  });
  for (const page of pages.slice(0, 5)) {
    selected.push(page);
    if (fits(envelope(), DEFAULT_MEMORY_OUTPUT_TOKENS)) continue;
    selected.pop();
    if (!selected.length) selected.push({ page_id: page.page_id, requires_read: true });
    break;
  }
  if (!fits(envelope(), DEFAULT_MEMORY_OUTPUT_TOKENS))
    throw new Error("memory_output_budget_exceeded");
  return envelope();
}

/** Generation descriptions are metadata, not evidence to repeat with every body page. */
export function boundedKnowledgeRead(page: Row, view: KnowledgeReadView = {}, scope = ""): Row {
  const budget = view.output_tokens ?? DEFAULT_MEMORY_OUTPUT_TOKENS;
  if (typeof page.body !== "string" && !view.offset && !view.content_hash && fits(page, budget))
    return page;
  const { body: _body, ...metadata } = page;
  const part = typeof page.body === "string" ? (view.part ?? "body") : "metadata";
  const text = part === "metadata" ? JSON.stringify(metadata) : (page.body as string);
  const hash = createHash("sha256")
    .update(JSON.stringify([scope, part, page]))
    .digest("hex");
  return pagedEvidence(
    text,
    view,
    hash,
    {
      id: page.id,
      name: page.name,
      last_updated_at: page.last_updated_at,
      part,
      ...(part === "body" &&
      Object.keys(metadata).some((k) => !["id", "name", "last_updated_at"].includes(k))
        ? { metadata_available: true }
        : {}),
    },
    { id: page.id, part, metadata_omitted: true },
    "body"
  );
}

function pagedEvidence(
  text: string,
  view: MemoryReadView,
  hash: string,
  initial: Row,
  fallback: Row,
  key: "text" | "body"
): Row {
  const offset = view.offset ?? 0;
  const budget = view.output_tokens ?? DEFAULT_MEMORY_OUTPUT_TOKENS;
  if ((offset > 0 && !view.content_hash) || (view.content_hash && view.content_hash !== hash))
    throw new Error("memory_changed_restart_read");
  const chars = Array.from(text);
  if (offset > chars.length) throw new Error("invalid_memory_offset");
  let details: Row = initial;
  const packet = (length: number): Row => ({
    evidence_guidance: MEMORY_RESULT_GUIDE,
    ...details,
    [key]: chars.slice(offset, offset + length).join(""),
    offset,
    total_chars: chars.length,
    content_hash: hash,
    text_truncated: offset + length < chars.length,
    ...(offset + length < chars.length ? { next_offset: offset + length } : {}),
  });
  if (!fits(packet(0), budget)) {
    // Large provenance remains explicitly readable, rather than silently disappearing.
    details = fallback;
  }
  let low = 0,
    high = Math.min(chars.length - offset, budget * 16);
  while (low < high) {
    const n = Math.ceil((low + high) / 2);
    if (fits(packet(n), budget)) low = n;
    else high = n - 1;
  }
  // JSON/BPE boundary changes are not strictly monotone; the final serialized packet is decisive.
  while (low > 0 && !fits(packet(low), budget)) low--;
  const out = packet(low);
  if (!fits(out, budget) || (low === 0 && offset < chars.length))
    throw new Error("memory_output_budget_exceeded");
  return out;
}
