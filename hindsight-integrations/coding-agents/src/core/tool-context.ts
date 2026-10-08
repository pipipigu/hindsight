import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

export type PermissionMode = "normal" | "plan" | "unknown";
export function permissionMode(value: unknown): PermissionMode {
  if (value === "plan") return "plan";
  return ["default", "normal", "acceptEdits", "bypassPermissions", "dontAsk"].includes(
    String(value)
  )
    ? "normal"
    : "unknown";
}
const claimsSchema = z.object({
  cwd: z.string(),
  harness: z.enum(["codex", "claude-code"]),
  session: z.string(),
  mode: z.enum(["normal", "plan", "unknown"]),
  tool: z.string(),
  input: z.string(),
  expires: z.number(),
});
function key(): Buffer {
  const file =
    process.env.HINDSIGHT_CONTEXT_KEY_FILE ||
    join(homedir(), ".hindsight", "shared-memory", "context.key");
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(file, randomBytes(32), { flag: "wx", mode: 0o600 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  const value = readFileSync(file);
  if (value.length !== 32) throw new Error("invalid_context_key");
  return value;
}
export function cleanArguments(input: Record<string, unknown>): Record<string, unknown> {
  const { _context: _ignored, ...args } = input;
  return args;
}
function fingerprint(input: Record<string, unknown>): string {
  const args = cleanArguments(input);
  return createHash("sha256")
    .update(
      JSON.stringify(
        Object.keys(args)
          .sort()
          .map((k) => [k, args[k]])
      )
    )
    .digest("hex");
}
export function signToolContext(
  claims: Omit<z.infer<typeof claimsSchema>, "input" | "expires">,
  args: Record<string, unknown>
): string {
  const body = Buffer.from(
    JSON.stringify({ ...claims, input: fingerprint(args), expires: Date.now() + 120000 })
  ).toString("base64url");
  return body + "." + createHmac("sha256", key()).update(body).digest("base64url");
}
export function verifyToolContext(token: unknown, tool: string, args: Record<string, unknown>) {
  if (typeof token !== "string" || token.length > 16000) throw new Error("tool_context_required");
  const [body, sig, extra] = token.split(".");
  if (!body || !sig || extra) throw new Error("invalid_tool_context");
  const wanted = createHmac("sha256", key()).update(body).digest(),
    actual = Buffer.from(sig, "base64url");
  if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted))
    throw new Error("invalid_tool_context");
  const claims = claimsSchema.parse(JSON.parse(Buffer.from(body, "base64url").toString()));
  if (claims.expires < Date.now() || claims.tool !== tool || claims.input !== fingerprint(args))
    throw new Error("expired_or_changed_tool_context");
  return claims;
}
export function assertCanWrite(mode: PermissionMode): void {
  if (mode !== "normal")
    throw new Error(mode === "plan" ? "plan_readonly" : "host_permission_unavailable");
}
