import { recallAnchors } from "./recall-topic";

/** API ranking and semantic reranking are different signals; page RRF scores never enter here. */
export interface RecallScores {
  reranker?: number | null;
  semantic?: number | null;
  final?: number | null;
  keyword?: number | null;
}
export interface RecallFact {
  id?: string;
  text: string;
  document_id?: string;
  mentioned_at?: string;
  occurred_start?: string;
  scores?: RecallScores;
}
export interface EvidenceSource {
  source: "memory" | "knowledge";
  id?: string;
  title?: string;
  documentId?: string;
  date?: string;
  section?: string;
  attribution?: string;
}
export interface Evidence extends EvidenceSource {
  text: string;
  references?: EvidenceSource[];
}
export interface Passage {
  text: string;
  section?: string;
}
export interface EvidenceCandidate extends Evidence {
  reranker?: number;
  derived?: boolean;
}
export interface RankedEvidence extends Evidence {
  relevance: number;
  lexical: number;
}

const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
// Language glue, never business vocabulary. CJK bigrams also work when ICU splits nouns into
// single characters (including on the installed Node runtime).
const glue =
  /^(?:的|了|是|有|吗|呢|啊|吧|和|与|在|后|前|把|将|从|为|等|我|你|主要|哪些|什么|如何|怎么|为什么|是否|这个|那个|这样|这么|实现)$/u;
const normalize = (text: string) => text.normalize("NFKC").toLowerCase();

export function evidenceTerms(text: string): string[] {
  const terms = new Set(recallAnchors(text, 200));
  let han = "";
  const flush = () => {
    if (han.length === 1) terms.add(han);
    for (let i = 0; i + 1 < han.length; i++) terms.add(han.slice(i, i + 2));
    han = "";
  };
  for (const part of segmenter.segment(normalize(text))) {
    if (/^\p{Script=Han}$/u.test(part.segment) && !glue.test(part.segment)) han += part.segment;
    else {
      flush();
      if (/^\p{Script=Han}{2,}$/u.test(part.segment) && !glue.test(part.segment))
        terms.add(part.segment);
    }
  }
  flush();
  // Keep exact technical identifiers as well as their ordinary-language parts.
  for (const id of text.match(/\b[A-Za-z][A-Za-z0-9]*(?:[_./-][A-Za-z0-9]+)+\b/g) ?? [])
    terms.add(normalize(id));
  return [...terms].filter((t) => !glue.test(t)).slice(0, 96);
}

/** Markdown sections, paragraphs and tables; the emitted text always comes verbatim from the source. */
export function passagesOf(body: string, maxChars = 1200): Passage[] {
  const passages: Passage[] = [],
    headings: string[] = [];
  let lines: string[] = [],
    fence = false;
  const flush = () => {
    const text = lines.join("\n").trim();
    lines = [];
    if (!text) return;
    const section = headings.filter(Boolean).join(" / ") || undefined;
    if (text.length <= maxChars) {
      passages.push({ text, section });
      return;
    }
    const table = /^\s*\|.*\|\s*$/m.test(text),
      parts = text.split(/(?<=[。！？;；])\s*|(?<=[.!?])\s+(?=[A-Z])|\n/);
    const header = table && parts.length > 2 ? parts.slice(0, 2).join("\n") : "";
    let chunk = "";
    for (const part of parts) {
      if (chunk && chunk.length + part.length + 1 > maxChars) {
        passages.push({ text: chunk, section });
        chunk = header && !part.includes(header) ? header : "";
      }
      // A single unbroken line must not consume the entire injection budget.
      for (let offset = 0; offset < part.length; offset += maxChars) {
        const piece = part.slice(offset, offset + maxChars);
        if (offset > 0 && chunk) {
          passages.push({ text: chunk, section });
          chunk = "";
        }
        chunk += (chunk ? "\n" : "") + piece;
      }
    }
    if (chunk) passages.push({ text: chunk, section });
  };
  for (const line of body.slice(0, 60000).split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      lines.push(line);
      continue;
    }
    const heading = !fence && /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      flush();
      headings.length = heading[1].length;
      headings[heading[1].length - 1] = heading[2].trim();
      continue;
    }
    if (!fence && /^\s*\d+[.)、]\s+\S/.test(line) && lines.length) flush();
    if (!fence && !line.trim()) flush();
    else lines.push(line);
  }
  flush();
  return passages.slice(0, 160);
}

function sourceOf(e: Evidence): EvidenceSource {
  const { source, id, title, documentId, date, section, attribution } = e;
  return {
    source,
    ...(id ? { id } : {}),
    ...(title ? { title } : {}),
    ...(documentId ? { documentId } : {}),
    ...(date ? { date } : {}),
    ...(section ? { section } : {}),
    ...(attribution ? { attribution } : {}),
  };
}
function literalSignature(text: string): string {
  // Similar sentences with changed values or negation are competing evidence, not duplicates.
  return (
    text.match(
      /\b\d{1,3}(?:,\d{3})+(?:\.\d+)?|\b\d+(?:[.:/-]\d+)*\b|`[^`]+`|"[^"\n]+"|'[^'\n]+'|【[^】]+】|「[^」]+」|“[^”]+”|\b[A-Z][A-Z0-9_]{2,}\b|\b[a-z]+(?:[_./-][a-z0-9]+)+\b|\b(?:true|false|not|never|without|only|unless|except|before|after|minimum|maximum|at least|at most)\b|至少|最多|必须|允许|[不未无禁]|[+*/%=<>!-]/g
    ) ?? []
  )
    .map((value) => (/^\d/.test(value) ? value.replaceAll(",", "") : value.normalize("NFKC")))
    .join("\u0000");
}
const canonical = (text: string) => normalize(text).replace(/[^\p{L}\p{N}]+/gu, "");
function shingles(text: string): Set<string> {
  const value = canonical(text),
    result = new Set<string>();
  for (let i = 0; i + 4 <= value.length; i++) result.add(value.slice(i, i + 4));
  return result;
}
function duplicate(a: string, b: string): boolean {
  if (literalSignature(a) !== literalSignature(b)) return false;
  if (canonical(a) === canonical(b)) return true;
  const x = shingles(a),
    y = shingles(b);
  if (!x.size || !y.size) return false;
  let shared = 0;
  for (const key of x) if (y.has(key)) shared++;
  return shared / (x.size + y.size - shared) >= 0.82;
}

/** Budget selection favours new information instead of many paraphrases of the same passage. */
export function diversifyEvidence(rows: RankedEvidence[]): RankedEvidence[] {
  const remaining = rows.map((row) => ({ row, keys: shingles(row.text) }));
  const selected: typeof remaining = [];
  const similarity = (a: Set<string>, b: Set<string>) => {
    let common = 0;
    for (const key of a) if (b.has(key)) common++;
    return common / Math.max(1, Math.min(a.size, b.size));
  };
  while (remaining.length) {
    let best = 0,
      value = -Infinity;
    for (const [index, candidate] of remaining.entries()) {
      const redundancy = selected.reduce(
        (score, existing) => Math.max(score, similarity(candidate.keys, existing.keys)),
        0
      );
      const utility = candidate.row.relevance - 0.45 * redundancy;
      if (utility > value) {
        value = utility;
        best = index;
      }
    }
    selected.push(remaining.splice(best, 1)[0]);
  }
  return selected.map((x) => x.row);
}

export function rankEvidence(query: string, candidates: EvidenceCandidate[]) {
  const terms = evidenceTerms(query),
    docs = candidates.map((c) => normalize(`${c.title ?? ""}\n${c.section ?? ""}\n${c.text}`));
  const weights = terms.map((term) =>
    Math.log(1 + (docs.length + 1) / (1 + docs.filter((d) => d.includes(term)).length))
  );
  const weight = weights.reduce((a, b) => a + b, 0);
  const peak = Math.max(
    0,
    ...candidates.filter((c) => c.source === "memory").map((c) => c.reranker ?? 0)
  );
  const semanticBand = Math.max(0.5, peak * 0.75);
  const literals =
    query.match(
      /`[^`]+`|\b[A-Z][A-Z0-9_]{2,}\b|\b[A-Za-z][A-Za-z0-9]*(?:[_./-][A-Za-z0-9]+)+\b/g
    ) ?? [];
  const semanticSupports = candidates
    .filter((c) => c.source === "memory" && !c.derived && (c.reranker ?? -1) >= semanticBand)
    .map((c) => ({
      score: c.reranker ?? 0,
      keys: evidenceTerms(c.text).filter((t) => !terms.includes(t)),
    }));
  let rejected = 0,
    duplicates = 0;
  const ranked: RankedEvidence[] = [];
  for (const [index, candidate] of candidates.entries()) {
    const direct = normalize(candidate.text);
    const matched = terms.filter((term) => direct.includes(term));
    const lexical =
      weight && matched.length
        ? weights.reduce((sum, w, i) => sum + (docs[index].includes(terms[i]) ? w : 0), 0) / weight
        : 0;
    const semantic = candidate.source === "memory" ? (candidate.reranker ?? 0) : 0;
    if (candidate.source === "memory" && candidate.reranker !== undefined) {
      const exactLiteral = literals.some((literal) =>
        direct.includes(normalize(literal.replaceAll("`", "")))
      );
      if (
        (peak >= 0.5 && semantic < semanticBand && !exactLiteral) ||
        (candidate.derived && lexical < 0.6)
      ) {
        rejected++;
        continue;
      }
    }
    // Absolute reranker scores are not calibrated across all queries: exact content evidence
    // remains usable even at a low score. Conversely an RRF rank alone admits nothing.
    let support = 0;
    if (candidate.source === "knowledge" && lexical < 0.6) {
      for (const fact of semanticSupports) {
        const keys = fact.keys;
        const common = keys.filter((t) => direct.includes(t));
        if (common.length >= 3 && common.length / Math.max(1, keys.length) >= 0.25)
          support = Math.max(support, fact.score * 0.75);
      }
    }
    if (lexical < 0.6 && semantic < 0.5 && support < 0.5) {
      rejected++;
      continue;
    }
    const structure = /(^|\n)\s*(?:\||```|~~~|\d+[.)]\s)|\b[A-Z][A-Z0-9_]{2,}\b/m.test(
      candidate.text
    )
      ? 0.04
      : 0;
    const { reranker: _score, derived: _derived, ...evidence } = candidate;
    // Preserve semantic ordering of facts; literal topic repetition is not confidence.
    const directCount = terms.reduce((sum, term) => sum + (direct.split(term).length - 1), 0);
    const locality =
      Math.max(1, directCount) / (Math.max(1, directCount) + candidate.text.length / 400);
    const relevance =
      candidate.source === "memory" && candidate.reranker !== undefined
        ? semantic
        : Math.max(lexical, support) * locality;
    const efficiency = 1 / Math.sqrt(1 + candidate.text.length / 400);
    ranked.push({
      ...evidence,
      relevance: (relevance + structure) * efficiency,
      lexical,
    });
  }
  ranked.sort(
    (a, b) =>
      b.relevance - a.relevance ||
      b.lexical - a.lexical ||
      a.text.length - b.text.length ||
      canonical(a.text).localeCompare(canonical(b.text)) ||
      (a.id ?? "").localeCompare(b.id ?? "")
  );
  const kept: RankedEvidence[] = [],
    counts = new Map<string, number>();
  for (const candidate of ranked) {
    const key = `${candidate.source}:${candidate.id ?? candidate.text}`;
    if ((counts.get(key) ?? 0) >= 2) {
      rejected++;
      continue;
    }
    const existing = kept.find((k) => duplicate(k.text, candidate.text));
    if (existing) {
      const refs = existing.references ?? [sourceOf(existing)];
      const ref = sourceOf(candidate);
      if (!refs.some((r) => JSON.stringify(r) === JSON.stringify(ref))) refs.push(ref);
      existing.references = refs.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      duplicates++;
      continue;
    }
    counts.set(key, (counts.get(key) ?? 0) + 1);
    kept.push(candidate);
  }
  return { ranked: kept, rejected, duplicates };
}
