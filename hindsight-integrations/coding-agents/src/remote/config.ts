import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";

const bank = z.string().trim().min(1).max(256);
const clientSchema = z
  .object({
    id: z.string().min(1).max(128),
    tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
    mode: z.enum(["library", "project"]),
    allowedBanks: z.union([z.literal("*"), z.array(bank).max(1000)]).optional(),
    bankId: bank.optional(),
    read: z.boolean(),
    write: z.boolean(),
  })
  .strict()
  .superRefine((client, ctx) => {
    if (client.mode === "project" && (!client.bankId || client.allowedBanks !== undefined))
      ctx.addIssue({ code: "custom", message: "project_requires_fixed_bank" });
    if (
      client.mode === "library" &&
      (client.bankId !== undefined || client.allowedBanks === undefined)
    )
      ctx.addIssue({ code: "custom", message: "library_requires_allowed_banks" });
    if (client.write && !client.read)
      ctx.addIssue({ code: "custom", message: "write_requires_read" });
  });

const schema = z
  .object({
    apiUrl: z.string().url(),
    apiToken: z.string().optional(),
    dedupScopeId: z.string().min(1).optional(),
    toolGuideExtra: z.string().max(16000).optional(),
    bindHost: z.string().default("127.0.0.1"),
    port: z.number().int().min(0).max(65535).default(8787),
    maxConcurrentTools: z.number().int().min(1).max(32).default(8),
    maxConcurrentToolsPerClient: z.number().int().min(1).max(8).default(2),
    publicOrigin: z.string().url(),
    clients: z.array(clientSchema).min(1).max(100),
  })
  .strict()
  .superRefine((config, ctx) => {
    const origin = new URL(config.publicOrigin);
    if (
      !["http:", "https:"].includes(origin.protocol) ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash
    )
      ctx.addIssue({ code: "custom", message: "public_origin_must_be_origin" });
    const backend = new URL(config.apiUrl);
    if (
      !["http:", "https:"].includes(backend.protocol) ||
      backend.username ||
      backend.password ||
      backend.search ||
      backend.hash
    )
      ctx.addIssue({ code: "custom", message: "invalid_backend_url" });
    if (
      new Set(config.clients.map((c) => c.id)).size !== config.clients.length ||
      new Set(config.clients.map((c) => c.tokenHash)).size !== config.clients.length
    )
      ctx.addIssue({ code: "custom", message: "duplicate_client" });
  });
export type RemoteConfig = z.infer<typeof schema>;
export type RemotePrincipal = RemoteConfig["clients"][number];
export function loadRemoteConfig(path: string): RemoteConfig {
  try {
    return schema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    throw new Error("invalid_remote_configuration");
  }
}
export function credentialHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
export function authenticate(
  config: RemoteConfig,
  authorization?: string
): RemotePrincipal | undefined {
  const match = authorization?.match(/^Bearer ([^\s]{32,4096})$/);
  if (!match) return undefined;
  const hash = Buffer.from(credentialHash(match[1]), "hex");
  return config.clients.find((client) =>
    timingSafeEqual(hash, Buffer.from(client.tokenHash, "hex"))
  );
}
export function policyRevision(config: RemoteConfig, client: RemotePrincipal): string {
  return credentialHash(
    JSON.stringify({
      apiUrl: config.apiUrl.replace(/\/$/, ""),
      backendCredentialHash: credentialHash(config.apiToken ?? "anonymous"),
      dedupScopeId: config.dedupScopeId,
      ...client,
    })
  );
}
export function permitsBank(client: RemotePrincipal, bankId: string): boolean {
  return client.mode === "project"
    ? client.bankId === bankId
    : client.allowedBanks === "*" || !!client.allowedBanks?.includes(bankId);
}
