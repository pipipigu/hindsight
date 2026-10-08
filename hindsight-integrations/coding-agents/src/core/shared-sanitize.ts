/** Only known credentials and common secret forms are redacted; this is not a general DLP system. */
export function sanitizeSharedText(
  text: string,
  secrets: readonly (string | undefined)[] = []
): string {
  let clean = text
    .replace(
      /<(?:codex-shared-memory|hindsight-memory|environment_context|system-reminder)\b[^>]*>[\s\S]*?<\/(?:codex-shared-memory|hindsight-memory|environment_context|system-reminder)>/gi,
      ""
    )
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      "[REDACTED PRIVATE KEY]"
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]")
    .replace(
      /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{12,}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b/g,
      "[REDACTED]"
    )
    .replace(
      /(["']?(?:api[_-]?key|password|passwd|access[_-]?token|refresh[_-]?token|secret)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi,
      "$1[REDACTED]"
    );
  for (const secret of secrets)
    if (secret && secret.length >= 6) clean = clean.split(secret).join("[REDACTED]");
  return clean.replace(/\r\n?/g, "\n").trim();
}
