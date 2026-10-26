import { MEMORY_SEARCH_GUIDE } from "./recall-guidance";

export interface PageRef {
  id: string;
  title: string;
}

/** Defensive parse of HindsightClient.listPages() ({items:[{id,name}]}, flattened from the
 *  knowledge-base tree). The ids are knowledge-base node ids — the same id space the agent passes
 *  back to hindsight_read_knowledge_page. */
export function parsePageList(raw: unknown): PageRef[] {
  const items = (raw as { items?: unknown })?.items;
  if (!Array.isArray(items)) return [];
  const out: PageRef[] = [];
  for (const it of items) {
    const id = (it as { id?: unknown })?.id;
    const name = (it as { name?: unknown })?.name;
    if (typeof id === "string" && typeof name === "string") out.push({ id, title: name });
  }
  return out;
}

const EMPTY_STATE =
  "No knowledge pages yet — Hindsight is still learning this repo; they'll appear as it processes.";

/**
 * What the agent is told EXISTS, without listing it.
 *
 * A full roster of titles and ids reads as an index, and an index makes search
 * pointless: measured over 40 real Claude Code turns against a prefilled bank, every single
 * retrieval was `hindsight_read_knowledge_page` called with an id copied from this
 * block — 0 searches at 3 pages, and still 0 at 12. The model was right: searching to
 * locate one of a dozen titles already in its context buys nothing.
 *
 * It is the wrong trade anyway. A title says what a page is ABOUT; the search
 * returns the passage that bears on THIS turn, ranked, across pages whose titles
 * give no hint. Naming the count and the way in, rather than the contents, is what
 * makes the first call a search.
 */
function indexLine(pages: PageRef[]): string {
  const count =
    pages.length === 1 ? "1 knowledge page covers" : `${pages.length} knowledge pages cover`;
  return (
    `${count} this repository — architecture, conventions, past decisions and ` +
    "in-flight initiatives. They are deliberately NOT listed here: call " +
    "hindsight_search_knowledge_pages(query) to find the ones that bear on the current turn, then " +
    "hindsight_read_knowledge_page(<id>) on anything the results show is worth reading in full."
  );
}

/**
 * When-to-call guide for the FULL Hindsight tool suite. Shared by the SessionStart preamble and the
 * periodic refresh so the agent is told — repeatedly — not just that the tools exist but the moment
 * to reach for each one. Registering the tools isn't enough; the trigger for each has to be in
 * context. (Omits hindsight_diagnose — pure troubleshooting, no workflow trigger.)
 */
const TOOL_GUIDE =
  "- hindsight_recall(query) — prefer for concrete facts; hindsight_search_observations(query) — summarized experience and supporting facts. Stop when sufficient evidence is available.\n" +
  "- hindsight_search_knowledge_pages(query) — search for project overviews and topics. Choose the tool that fits the question. The code " +
  "shows what is true today but not what was decided or why; memory shows what was decided or said " +
  "back then but not whether it still holds. Work built from either alone goes wrong: from code alone " +
  "it quietly re-litigates settled questions, from memory alone it acts on stale claims. Search " +
  "BEFORE you act when the current conversation lacks the historical evidence needed for these tasks; " +
  "do not repeat a search just because a task continues:\n" +
  "    • the user reports a bug or a wrong response (the intended behaviour, and the status code or " +
  "value it should return, may already have been decided);\n" +
  "    • you are about to write or change a test (what this project expects a change to ship with, and " +
  "how it asserts, is a convention, not a preference);\n" +
  "    • you are implementing something new, or two parts have to fit together;\n" +
  "    • the user asks why something is the way it is, or what is left to do;\n" +
  "    • you are about to commit, and need to know what the change was supposed to honour.\n" +
  "  It ranks the pages by relevance and returns the matching passage, which a page title cannot tell " +
  "you. What it returns is a past record, not a live reading: a claim that something was fixed, " +
  "passes, or works is what someone said then — check it against the code before you rely on it, " +
  "and say so when the two disagree.\n" +
  "  CREDITING IS NOT OPTIONAL AND NOT A JUDGEMENT CALL. If you called this tool and anything it " +
  "returned reached your reply — quoted, paraphrased, or merely confirming what you were about to " +
  "say — open that part with a markdown blockquote, exactly: " +
  '"> 🧠 **From Hindsight memory (<page>)** — <the specific facts you drew on>". Rewriting a ' +
  "snippet in your own words does not make it yours. A search that turned up nothing useful needs " +
  "no mention at all — just carry on.\n" +
  "- hindsight_list_knowledge_pages — use for catalog questions, not as a required first step. " +
  "hindsight_read_knowledge_page — read a relevant hit only when its snippet leaves an evidence gap; " +
  "follow [[page:<id>]] links only to resolve that gap.\n" +
  "- hindsight_reflect(query) — when pages are too shallow and you need the WHY: deep reasoning over the " +
  "repo's full memory for the past decision and exact values that explain a behavior or bug (slower — " +
  'use deliberately, and credit results with a blockquote header "> 🧠 **From Hindsight memory** — <summary>").\n' +
  "- hindsight_capture_initiative(title, summary) — right after the user approves a plan or finishes brainstorming a " +
  "new feature/capability and you are about to start implementing (BEFORE you write any code), call this to " +
  "record it as a tracked page; then call it AGAIN with relates_to_page_id set to that page whenever the goal, " +
  "scope, or rationale materially changes mid-work, so the page tracks the current plan and not the opening one. " +
  "Skip bug fixes, small tweaks, chores, and trivial course-corrections.\n" +
  "- hindsight_ingest_document(title, content) — save an external document or durable notes/findings you want " +
  "remembered (not the current conversation — that is captured automatically at session end).";

/**
 * Any autoInject other than "reflect" means no first-prompt synthesis. Keep the pull trigger explicit,
 * and let the question choose the query tool rather than requiring a page-search chain.
 */
const QUERY_ON_GOALS =
  "- First decide whether the NEW task or goal needs historical evidence missing from the current " +
  "conversation. If so, choose the appropriate memory query tool; otherwise proceed directly. Concrete " +
  "facts can go directly to hindsight_recall; a synthesis can go directly to hindsight_reflect. " +
  "Do not require a page search or full-page read before either.\n";

export interface ToolGuideOpts {
  /** Add the new-goal pull trigger (cfg.autoInject !== "reflect"). Kept under its existing name
   *  for adapter compatibility; the question chooses the tool, with no required page-first path. */
  reflectOnNewGoals?: boolean;
  /** cfg.toolGuideExtra: the team's own guidance, added after ours rather than replacing it. */
  extra?: string;
}

function toolGuide(opts?: ToolGuideOpts): string {
  const extra = opts?.extra?.trim();
  return (
    MEMORY_SEARCH_GUIDE +
    "\n" +
    (opts?.reflectOnNewGoals ? QUERY_ON_GOALS : "") +
    TOOL_GUIDE +
    (extra ? `\n${extra}` : "")
  );
}

/** SessionStart: teach the whole tool suite + when to use each, and list what pages exist. Empty-state aware. */
export function buildKnowledgePreamble(pages: PageRef[], opts?: ToolGuideOpts): string {
  const body = pages.length ? indexLine(pages) : EMPTY_STATE;
  return (
    "<hindsight_knowledge>\n" +
    "This repository has a Hindsight memory + knowledge base (curated, continuously-updated pages plus the raw " +
    "memory behind them). The tools below are registered, but you must actually CALL them at the right moments:\n" +
    `${toolGuide(opts)}\n` +
    "ALSO your correction tool: when you verify a Hindsight memory is wrong or stale, ingest a " +
    '"Correction: <topic>" doc stating what memory claimed, what is true now, and the evidence — ' +
    "newer facts supersede older ones.\n" +
    `${body}\n` +
    "This tool guide and the page list are re-injected for you periodically as things change.\n" +
    "</hindsight_knowledge>"
  );
}

/**
 * Periodic UserPromptSubmit refresh. ALWAYS emits (never undefined) so the full tool guide keeps
 * re-appearing in context even on a fresh repo with no pages yet — precisely when the agent is
 * building its first features. The page roster is included only when pages exist; the reminder of
 * which tools exist and WHEN to call each is unconditional.
 */
export function buildRosterRefresh(pages: PageRef[], opts?: ToolGuideOpts): string {
  const rosterBlock = pages.length ? `${indexLine(pages)}\n` : "";
  return (
    "<hindsight_knowledge_refresh>\n" +
    rosterBlock +
    "Reminder — this repo's Hindsight tools are available; call them at the right moments:\n" +
    `${toolGuide(opts)}\n` +
    "</hindsight_knowledge_refresh>"
  );
}
