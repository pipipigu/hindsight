import { z } from "zod";
import { sanitizeSharedText } from "./shared-sanitize";

const tokens = z.number().int().min(1).max(32768);
const tokenOptions = z.object({ max_tokens: tokens.optional() }).strict();
const tagsMatch = z.enum(["any", "all", "any_strict", "all_strict", "exact"]);
type TagGroup =
  | { tags: string[]; match?: z.infer<typeof tagsMatch>; resolve?: "exact" | "fuzzy" }
  | { and: TagGroup[] }
  | { or: TagGroup[] }
  | { not: TagGroup };
const tagGroup: z.ZodType<TagGroup> = z.lazy(() =>
  z.union([
    z
      .object({
        tags: z.array(z.string()),
        match: tagsMatch.optional(),
        resolve: z.enum(["exact", "fuzzy"]).optional(),
      })
      .strict(),
    z.object({ and: z.array(tagGroup).min(1) }).strict(),
    z.object({ or: z.array(tagGroup).min(1) }).strict(),
    z.object({ not: tagGroup }).strict(),
  ])
);

/** The public Recall request options; the project bank is supplied exclusively by the host. */
export const recallQueryShape = {
  query: z
    .string()
    .min(1)
    .max(8000)
    .describe("Question to search the current project's memories for"),
  types: z
    .array(z.enum(["world", "experience", "observation"]))
    .min(1)
    .nullable()
    .optional()
    .describe("Recall only: default world and experience; null searches all types"),
  budget: z
    .enum(["low", "mid", "high"])
    .optional()
    .describe("Retrieval effort, matching the Recall analyzer; default mid"),
  max_tokens: tokens
    .optional()
    .describe("Server result token budget; default 4096, independent of automatic injection"),
  tags: z.array(z.string()).nullable().optional(),
  tags_match: tagsMatch.optional(),
  tag_groups: z
    .array(tagGroup)
    .nullable()
    .optional()
    .describe("Compound tag filters; mutually exclusive with tags"),
  query_timestamp: z
    .string()
    .optional()
    .describe("ISO date used to anchor relative time expressions"),
  temporal_window: z
    .object({ start: z.string(), end: z.string() })
    .strict()
    .nullable()
    .optional()
    .describe("ISO start/end for temporal ranking, not a strict date filter"),
  min_scores: z
    .object({
      semantic: z.number().nullable().optional(),
      keyword: z.number().nullable().optional(),
      reranker: z.number().nullable().optional(),
      final: z.number().nullable().optional(),
    })
    .strict()
    .nullable()
    .optional(),
  prefer_observations: z.boolean().optional(),
  include: z
    .object({
      entities: tokenOptions.nullable().optional(),
      chunks: tokenOptions.nullable().optional(),
      source_facts: z
        .object({ max_tokens: tokens.optional(), max_tokens_per_observation: tokens.optional() })
        .strict()
        .nullable()
        .optional(),
    })
    .strict()
    .optional()
    .describe(
      "Return entity context, raw chunks or observation source facts; null disables an arm"
    ),
  trace: z
    .boolean()
    .optional()
    .describe("Include the Recall analyzer's retrieval trace; default false"),
};
const { types: _types, ...observationShape } = recallQueryShape;
export const observationsQueryShape = observationShape;
const recallSchema = z.object(recallQueryShape).strict();
const observationSchema = z.object(observationsQueryShape).strict();
export type RecallQuery = z.infer<typeof recallSchema>;

export function parseRecallQuery(args: unknown, observations: boolean): RecallQuery {
  const parsed: RecallQuery = observations
    ? observationSchema.parse(args)
    : recallSchema.parse(args);
  if (!/[\p{L}\p{N}]/u.test(parsed.query)) throw new Error("invalid_memory_query");
  if (
    parsed.tags !== undefined &&
    parsed.tags !== null &&
    parsed.tag_groups !== undefined &&
    parsed.tag_groups !== null
  )
    throw new Error("conflicting_tag_filters");
  if (parsed.query_timestamp !== undefined && !Number.isFinite(Date.parse(parsed.query_timestamp)))
    throw new Error("invalid_query_timestamp");
  if (parsed.temporal_window) {
    const { start, end } = parsed.temporal_window;
    if (
      !Number.isFinite(Date.parse(start)) ||
      !Number.isFinite(Date.parse(end)) ||
      Date.parse(start) > Date.parse(end)
    )
      throw new Error("invalid_temporal_window");
  }
  return {
    budget: "mid",
    max_tokens: 4096,
    ...(observations ? { include: { entities: null, source_facts: { max_tokens: 2048 } } } : {}),
    ...parsed,
    types: observations
      ? ["observation"]
      : parsed.types === undefined
        ? ["world", "experience"]
        : parsed.types,
  };
}

/** Preserve API structure/order while removing known credentials from historical source data. */
export function sanitizeRecallResponse(value: unknown, token?: string): unknown {
  if (typeof value === "string") {
    if (!value.trim()) return value;
    return (
      (value.match(/^\s*/)?.[0] ?? "") +
      sanitizeSharedText(value, [token]) +
      (value.match(/\s*$/)?.[0] ?? "")
    );
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeRecallResponse(item, token));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /^(?:api[_-]?key|password|passwd|access[_-]?token|refresh[_-]?token|secret)$/i.test(key)
          ? "[REDACTED]"
          : sanitizeRecallResponse(item, token),
      ])
    );
  return value;
}
