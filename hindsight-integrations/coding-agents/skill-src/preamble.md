---
name: hindsight-coding-agent
description: How this machine's Hindsight coding-agent memory works — the plugin behind the 🧠 banner. Use when the user says "store/remember this in hindsight", asks what the memory/knowledge pages are, wants to configure per-repo memory (disable, rename banks, git depth), or something memory-related looks broken.
---

# Hindsight Coding-Agent Memory

This machine runs the `hindsight-coding-agents` plugin: long-term project memory for coding
sessions, backed by a Hindsight server. You (the agent) are already wired into it — this skill
explains what happens automatically, which tools you have, and how to configure or debug it.

## Registry mode (this fork's default)

Projects use the independent directory registry, not Git-derived bank names. Unmapped projects are inactive. Automatic conversation capture and Git import are off. Save only new durable preferences, decisions, verified facts or reusable debugging conclusions with `hindsight_save_conclusion(content, evidence)`; never save routine progress or guesses, and do not save on a quota. Only `completed` confirms extraction. Plan or unknown host permissions are read-only. The five knowledge pages remain automatic. The behavior described below applies to explicit upstream compatibility mode.

主动查询先于本地文件与代码检索：知识专题使用 `hindsight_search_knowledge_pages`；归纳结论及支撑事实使用 `hindsight_search_observations`；具体事实使用 `hindsight_recall`；云端综合整理使用现有 `hindsight_reflect`。新检索工具支持 Recall 的类型、预算、token 上限、标签、时间排序、原文与追踪选项，保留服务端排序；主动查询不受自动注入的 2000 tokens 限制。`temporal_window` 影响排序，不是严格日期过滤。工具只读并绑定当前项目库。

两个检索工具默认返回精简 JSON：保留正文、时间、可辨识来源与引用，隐藏空项、评分及索引字段。`source_refs` 的 F 编号在 `sources` 中对应已返回依据的原始记忆 ID，`chunk_ref` 的 C 编号对应 `chunks` 中的原文片段，均仅在本次结果中有效。未返回正文的来源只显示 `missing_source_count`；截断标志会保留。指定 `output_format: "raw"` 可返回完整 API 数据及所有来源 ID；请求 `trace: true` 且未指定格式时也使用 raw。格式选择不影响服务端检索。

## Upstream-mode automatic behavior

- **Per-repo memory bank**: each repository resolves to a bank (shown in the session banner:
  `↳ memory bank “coding-agent::<repo>”`). Worktrees share the main repo's bank.
- **Ingestion builds itself**: on first open, the bank is seeded from recent commit messages and a
  read-only codebase survey; every session start, a background engine tops it up (new commits, new
  conversations) and keeps 5 knowledge pages current. There is NO ingest command to run.
- **Session synthesis**: by default, the first prompt of a session triggers one deep memory
  synthesis (`reflect`) injected into context. `autoInject` switches the source: `pages` (knowledge
  page search hits), `recall` (recalled observations), or `none` (nothing injected; the agent
  searches the knowledge pages first and reflects only when they are too shallow).
- **Write-back**: the session transcript is retained into the bank automatically at session end
  (per-turn on opencode). The user never needs to "save" a conversation.

## Storing things deliberately

When the user says "store this in hindsight" / "remember this":

- The **current conversation** is captured automatically at session end — say so; no tool needed.
- An **external document, notes, or durable findings** → `hindsight_ingest_document(title, content)`.
- A **new feature/initiative being started** → `hindsight_capture_initiative(title, summary)`,
  right after the plan is agreed and before code is written.
- A **plan that materially changed** (goal, scope, or rationale — including mid-implementation) →
  call `hindsight_capture_initiative` again with `relates_to_page_id` set to that initiative's page
  id, summarising the _current_ intent. Same page, updated plan — never a second page. Trivial
  course-corrections don't count.

## Retrieving

- `hindsight_search_knowledge_pages(query)` — FIRST STOP for project questions (components,
  conventions, past decisions, initiatives). Server-side hybrid search, fast.
- `hindsight_read_knowledge_page(page_id)` / `hindsight_list_knowledge_pages` — read pages fully.
- `hindsight_reflect(query)` — deep reasoning over the whole memory for WHY questions and exact
  decided values; slower (seconds), use deliberately.
- Credit visibly whenever memory informs an answer: start that part with
  `🧠 From Hindsight memory (<page>): …` — and never credit memory that didn't contribute.

## Correcting wrong or stale memory

If you verify that something Hindsight served is wrong or outdated (the code, git, or an external
source contradicts it), FIX THE RECORD — don't just ignore it. Call
`hindsight_ingest_document` with:

- **title**: `Correction: <topic>` (e.g. `Correction: retry policy 4xx set`)
- **content**: (1) what memory claimed, (2) what is verifiably true now, (3) the evidence you
  checked (file/commit/output). Quote exact values verbatim.

Newer facts supersede older ones in retrieval, so one clear correction permanently outranks the
stale memory. Do this whenever you catch a wrong injected memory, a stale knowledge-page claim, or
an outdated decision — silent disregard leaves the trap armed for the next session.
