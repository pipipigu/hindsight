---
name: hindsight-coding-agent
description: How this machine's Hindsight coding-agent memory works — the plugin behind the 🧠 banner. Use when the user says "store/remember this in hindsight", asks what the memory/knowledge pages are, wants to configure per-repo memory (disable, rename banks, git depth), or something memory-related looks broken.
---

# Hindsight Coding-Agent Memory

This machine runs the `hindsight-coding-agents` plugin: long-term project memory for coding
sessions, backed by a Hindsight server. You (the agent) are already wired into it — this skill
explains what happens automatically, which tools you have, and how to configure or debug it.

## Registry mode (this fork's default)

Projects use the independent directory registry, not Git-derived bank names. Unmapped projects are inactive. Automatic retrieval defaults to `autoInject: "none"`: the host injects rules without fetching evidence or a page roster; the agent queries explicitly. Automatic conversation capture and Git import are off. Save only new durable preferences, decisions, verified facts or reusable debugging conclusions with `hindsight_save_conclusion(content, evidence)`; never save routine progress or guesses, and do not save on a quota. Only `completed` confirms extraction. Plan or unknown host permissions are read-only. The five knowledge pages remain automatic. The behavior described below applies to explicit upstream compatibility mode.

每轮先按当前上下文判断是否需要新的历史证据；确认、衔接或当前对话足以处理时直接执行，用户明确要求查记忆或存在证据缺口时主动查询。Codex 首轮完整规则、后续短提醒，项目或规则变化时刷新。需要查询时，记忆先于本地文件与代码检索：具体事实优先 `hindsight_recall`，归纳经验用 `hindsight_search_observations`，概览与专题用知识页搜索，综合整理可直接用 `hindsight_reflect`。按需选择，不必全部调用；证据足够就停，补查只针对缺口。提案、历史报告与二次摘要须注明范围和时间；声称现行须有实施证据，导入时间不代表实施时间；不同模块不能直接拼接规则。推导须标明，冲突或缺失保留待确认；只凭记忆时不查本地。工具绑定当前项目库，保留服务端排序；`temporal_window` 影响排序，不是严格日期过滤。

两个检索工具默认精简 JSON：按服务端顺序最多返回5条完整事实，整包限约3000 tokens（分段 cl100k_base 估算，实际模型用量不同），包含来源与规则。`limit` 可调至10，`output_tokens` 可降低；`max_tokens` 只管服务端正文。`matched_count` 是本次取到的候选数，`omitted_count` 是未展示数，非全库总数。长事实只给 `requires_read` 地址，不截成结论；用 `hindsight_read_memory(memory_id)` 按需读取，`section=original` 只读该事实自己的原文，`section=provenance` 读完整来源状态。长内容按 `next_offset` 和 `content_hash` 续读，证据或项目变化时从头读。`seen_ids` 仅填当前上下文仍有正文的旧ID；引用失效时重读。F/C 引用在本次结果内有效；`source_ids` 可读取未返回的支撑事实。实体、原文和支撑事实共享整包预算，优先完整事实。`output_format=raw` 保留完整 API；`trace=true` 未指定格式时也使用 raw，二者仅用于用户明确要求的详细调试。

## Upstream-mode automatic behavior

知识页也按预算分页，续读用 `next_offset/content_hash`，生成描述按需用 `part=metadata`；Reflect 不变。

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

- `hindsight_recall(query)` — concrete facts and experiences; preferred for factual questions.
- `hindsight_search_observations(query)` — consolidated experience with supporting facts.
- `hindsight_search_knowledge_pages(query)` — project overviews and topics (components,
  conventions, past decisions, initiatives). Server-side hybrid search, fast; not a prerequisite
  for recall or reflect. Read a full page only when the snippet leaves a relevant evidence gap.
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
