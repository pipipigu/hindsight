/** Automatic recall uses only redacted, human-authored text from this session. */
export interface RecallTopic {
  text: string;
  at: number;
}
export interface RecallPlan {
  query?: string;
  topic?: RecallTopic;
  anchors: string[];
  reason: "direct" | "followup" | "acknowledgement" | "missing_topic" | "empty";
}
const MAX_TOPIC = 900;
const TOPIC_AGE = 24 * 60 * 60 * 1000;
const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
const ignored = new Set([
  "的",
  "了",
  "吗",
  "呢",
  "啊",
  "吧",
  "嘛",
  "这个",
  "那个",
  "这些",
  "那些",
  "这里",
  "那里",
  "这样",
  "那样",
  "什么",
  "怎么",
  "如何",
  "为什么",
  "是否",
  "还有",
  "需要",
  "可以",
  "一下",
  "现在",
  "目前",
  "刚才",
  "之前",
  "我们",
  "你们",
  "他们",
  "你的",
  "我的",
  "这个的",
  "问题",
  "情况",
  "状态",
  "进度",
  "风险",
  "结果",
  "地方",
  "内置",
  "检查",
  "查看",
  "看看",
  "确认",
  "了解",
  "帮我",
  "帮忙",
  "继续",
  "处理",
  "进行",
  "已经",
  "有没有",
  "项目",
  "任务",
  "系统",
  "内容",
  "东西",
  "通过",
  "多少",
  "测试",
  "修复",
  "一下子",
  "a",
  "an",
  "the",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "to",
  "of",
  "in",
  "on",
  "for",
  "at",
  "and",
  "or",
  "with",
  "from",
  "by",
  "as",
  "do",
  "does",
  "did",
  "i",
  "you",
  "we",
  "they",
  "my",
  "your",
  "our",
  "what",
  "which",
  "where",
  "when",
  "why",
  "how",
  "any",
  "about",
  "else",
  "other",
  "more",
  "still",
  "now",
  "then",
  "please",
  "can",
  "could",
  "would",
  "should",
  "check",
  "review",
  "inspect",
  "fix",
  "continue",
  "status",
  "progress",
  "issue",
  "issues",
  "problem",
  "problems",
  "risk",
  "risks",
  "result",
  "results",
  "project",
  "task",
  "system",
  "help",
]);
const acknowledgement =
  /^(?:(?:好|好的|好吧|你好|您好|行|可以|嗯|是|是的|对|对的|收到|了解|了解了|明白|明白了|知道了|谢谢|继续|继续吧|继续执行|接着做|开始吧|可以开始|按这个来|就这样|照做|已经重启了|已重启|重启好了|重启完成|完成了)[，,。.!！?？\s]*)+$/u;
const englishAcknowledgement =
  /^(?:ok(?:ay)?|yes|yep|hi|hello|thanks|thank you|got it|understood|continue|go on|go ahead|proceed|done|restarted)[.!?\s]*$/iu;
const topicSwitch =
  /(?:新(?:任务|话题)|另一个(?:任务|问题|话题)|换个(?:话题|问题)|切换到)|\b(?:new task|new topic|new question|different topic|switch to)\b/iu;
const reference =
  /(?:这[个些里样次种项]|那[个些里样项]|它|上述|刚才|上面|前面|第[一二三四五六七八九十\d]+[项点个条])|\b(?:this|that|these|those|it|them|above|previous)\b/iu;
const genericQuestion =
  /^(?:(?:那|还|再|目前|现在|你|您|我们|咱们|的|了|呢|吗|嘛|呀|啊|什么|如何|怎么|怎样|是否|能否|可以|需要|要|在|有|会|就|问题|风险|情况|状态|进度|结果|哪里|地方|做|处理|检查|确认|看看|内置|保存|实现|完成|其他|别的|样|么|不|也|和|吗的)|[\s，,。.!！?？])+$/u;

const normalize = (text: string) => text.normalize("NFKC").replace(/\s+/gu, " ").trim();
export function recallAnchors(text: string, limit = 32): string[] {
  const terms = [...segmenter.segment(normalize(text).toLowerCase())]
    .filter((part) => part.isWordLike)
    .map((part) => part.segment)
    .filter((term) => term.length >= 2 && /\p{L}/u.test(term) && !ignored.has(term));
  return [...new Set(terms)].slice(0, limit);
}
export function readRecallTopic(value: unknown, now = Date.now()): RecallTopic | undefined {
  if (!value || typeof value !== "object") return undefined;
  const topic = value as Partial<RecallTopic>;
  return typeof topic.text === "string" &&
    topic.text.length > 0 &&
    topic.text.length <= MAX_TOPIC &&
    typeof topic.at === "number" &&
    Number.isFinite(topic.at) &&
    topic.at <= now + 60000 &&
    now - topic.at <= TOPIC_AGE
    ? { text: topic.text, at: topic.at }
    : undefined;
}
export function planAutomaticRecall(
  prompt: string,
  previous?: RecallTopic,
  now = Date.now()
): RecallPlan {
  const text = normalize(prompt).slice(0, 8000),
    topic = readRecallTopic(previous, now);
  if (!text || text.startsWith("/")) return { topic, anchors: [], reason: "empty" };
  if (acknowledgement.test(text) || englishAcknowledgement.test(text))
    return { topic, anchors: [], reason: "acknowledgement" };
  const switched = topicSwitch.test(text);
  const anchors = recallAnchors(switched ? text.replace(topicSwitch, "") : text);
  if (switched && !anchors.length) return { anchors: [], reason: "missing_topic" };
  const named =
    text.match(
      /\b(?:[A-Z]{2,}[A-Za-z0-9_-]*|[A-Z][a-z]+[A-Za-z0-9_-]*|[A-Za-z0-9]+[_.-][A-Za-z0-9_.-]+)\b/gu
    ) ?? [];
  const newNamedTarget = named.some(
    (term) =>
      !ignored.has(term.toLowerCase()) &&
      topic &&
      !topic.text.toLowerCase().includes(term.toLowerCase())
  );
  const followup =
    text.length <= 160 &&
    !switched &&
    !newNamedTarget &&
    (reference.test(text) || genericQuestion.test(text) || anchors.length === 0);
  if (followup) {
    const priorAnchors = topic ? recallAnchors(topic.text) : [];
    if (!topic || !priorAnchors.length) return { anchors: [], reason: "missing_topic" };
    return {
      query: `${topic.text}\n当前追问：${text}`,
      topic,
      anchors: priorAnchors,
      reason: "followup",
    };
  }
  const compact = text.length <= MAX_TOPIC ? text : text.slice(0, 600) + " … " + text.slice(-297);
  return { query: text, topic: { text: compact, at: now }, anchors: [], reason: "direct" };
}
/** Only context-dependent follow-ups use this conservative lexical check. Explicit searches stay semantic. */
export function matchesRecallTopic(text: string, anchors: readonly string[]): boolean {
  if (!anchors.length) return true;
  const words = new Set(recallAnchors(text, 4000));
  const matched = anchors.filter((anchor) => words.has(anchor));
  return (
    matched.length >= Math.min(2, anchors.length) ||
    matched.some((anchor) => /^[a-z][a-z0-9_.-]{3,}$/u.test(anchor))
  );
}
