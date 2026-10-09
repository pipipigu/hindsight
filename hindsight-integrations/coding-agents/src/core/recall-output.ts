type Row = Record<string, unknown>;
const rowOf = (value: unknown): Row | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : undefined;
const fields = [
  "id",
  "text",
  "type",
  "context",
  "mentioned_at",
  "occurred_start",
  "occurred_end",
  "attachments",
  "state",
  "invalidation_reason",
  "invalidated_at",
  "edited_at",
];
// Keep provenance and evidence state, including false/zero values. The previous denylist kept
// growing as importer internals (agent ids, layer ids, hashes) reached the model in every result.
const metadataEvidence = new Set([
  "source",
  "source_kind",
  "source_path",
  "source_key",
  "source_url",
  "url",
  "title",
  "document_title",
  "document_status",
  "status",
  "tier",
  "verification",
  "evidence",
  "scope",
  "limitations",
  "verified",
  "verified_at",
  "version",
  "source_version",
  "valid_from",
  "valid_until",
]);

/** Remove empty properties, never false/zero or array positions. */
function nonempty(value: unknown): unknown {
  if (value === null || value === undefined || value === "") return undefined;
  if (Array.isArray(value)) return value.length ? value.map((v) => nonempty(v) ?? v) : undefined;
  const row = rowOf(value);
  if (row) {
    const pairs = Object.entries(row)
      .map(([k, v]) => [k, nonempty(v)] as const)
      .filter(([, v]) => v !== undefined);
    return pairs.length ? Object.fromEntries(pairs) : undefined;
  }
  return value;
}

/** Display projection only: all result rows and their text remain in server order. */
export function formatRecallResponse(
  payload: Row,
  format: "compact" | "raw",
  options: { includeEntities?: boolean } = {}
): Row {
  const results = payload.results as unknown[];
  if (format === "raw")
    return Object.fromEntries([
      ["result_count", results.length],
      ...Object.entries(payload).filter(([key]) => key !== "result_count"),
    ]);

  const facts = rowOf(payload.source_facts) ?? {};
  const chunks = rowOf(payload.chunks) ?? {};
  const refs = new Map<string, string>();
  const missingRefs = new Set<string>();
  const chunkRefs = new Map(Object.keys(chunks).map((id, index) => [id, `C${index + 1}`]));
  const reference = (id: string): string | undefined => {
    if (!Object.hasOwn(facts, id)) {
      missingRefs.add(id);
      return undefined;
    }
    if (!refs.has(id)) refs.set(id, `F${refs.size + 1}`);
    return refs.get(id)!;
  };
  const sourceIds = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  for (const value of results)
    for (const id of sourceIds(rowOf(value)?.source_fact_ids)) reference(id);
  for (const [id, value] of Object.entries(facts)) {
    reference(id);
    for (const parent of sourceIds(rowOf(value)?.source_fact_ids)) reference(parent);
  }

  const project = (value: unknown): unknown => {
    const row = rowOf(value);
    if (!row) return value;
    const out: Row = {};
    for (const key of fields) {
      const v = nonempty(row[key]);
      if (v !== undefined) out[key] = v;
    }
    if (options.includeEntities) {
      const entities = nonempty(row.entities);
      if (entities !== undefined) out.entities = entities;
    }
    if (Array.isArray(row.tags)) {
      const tags = row.tags.filter(
        (tag) =>
          typeof tag === "string" && tag !== "" && !/^(?:topic|task):[a-f0-9]{16,}$/i.test(tag)
      );
      if (tags.length) out.tags = tags;
    }
    const metadata = rowOf(row.metadata);
    if (metadata) {
      const cleaned = Object.fromEntries(
        Object.entries(metadata).filter(([key]) => metadataEvidence.has(key))
      );
      if (cleaned.source_key === cleaned.source_path) delete cleaned.source_key;
      const meaningful = nonempty(cleaned);
      if (meaningful !== undefined) out.metadata = meaningful;
    }
    const ids = sourceIds(row.source_fact_ids);
    const available = ids.map(reference).filter((ref) => ref !== undefined);
    if (available.length) out.source_refs = available;
    const missing = ids.filter((id) => !Object.hasOwn(facts, id)).length;
    if (missing) {
      out.missing_source_count = missing;
      out.source_ids = ids.filter((id) => !Object.hasOwn(facts, id));
    }
    if (typeof row.chunk_id === "string" && chunkRefs.has(row.chunk_id))
      out.chunk_ref = chunkRefs.get(row.chunk_id);
    return out;
  };

  const out: Row = { result_count: results.length, results: results.map(project) };
  if (refs.size) {
    out.sources = Object.fromEntries(
      [...refs].map(([id, ref]) => [
        ref,
        !Object.hasOwn(facts, id) ? { id } : { id, ...(rowOf(project(facts[id])) ?? {}) },
      ])
    );
  }
  if (missingRefs.size) out.missing_source_count = missingRefs.size;
  if (chunkRefs.size)
    out.chunks = Object.fromEntries(
      [...chunkRefs].map(([id, ref]) => [ref, nonempty(chunks[id]) ?? chunks[id]])
    );
  if (options.includeEntities) {
    const entities = nonempty(payload.entities);
    if (entities !== undefined) out.entities = entities;
  }
  for (const flag of ["source_facts_truncated", "chunks_truncated", "results_truncated"])
    if (typeof payload[flag] === "boolean") out[flag] = payload[flag];
  return out;
}
