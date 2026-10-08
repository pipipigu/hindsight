import { probeGitLayout } from "./git-layout";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";

export const registryPath = () =>
  process.env.HINDSIGHT_PROJECT_REGISTRY_FILE ||
  process.env.HINDSIGHT_PROJECT_REGISTRY ||
  join(homedir(), ".hindsight", "projects.json");
export const projectSchema = z.object({
  root: z.string().min(1),
  bankId: z.string().min(1),
  name: z.string().optional(),
  enabled: z.boolean().default(false),
});
export type RegisteredProject = z.infer<typeof projectSchema>;
const registrySchema = z.object({ projects: z.array(projectSchema) });
export class ProjectRegistryError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export function within(path: string, root: string): boolean {
  const part = relative(root, path);
  return !isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`);
}
function canonical(path: string): string {
  if (!isAbsolute(path)) throw new ProjectRegistryError("invalid_project_path");
  return existsSync(path) ? realpathSync.native(path) : resolve(path);
}
/** Git identifies a linked checkout's origin only; it never supplies a bank name. */
export function originalProjectPath(cwd: string): string {
  const actual = canonical(cwd),
    layout = probeGitLayout(actual);
  if (layout.status === "failed") throw new ProjectRegistryError("project_origin_unavailable");
  if (layout.status !== "resolved" || basename(layout.commonDir) !== ".git") return actual;
  let top = actual;
  while (!existsSync(join(top, ".git"))) {
    if (dirname(top) === top) return actual;
    top = dirname(top);
  }
  const origin = canonical(dirname(layout.commonDir));
  return origin === top ? actual : resolve(origin, relative(top, actual));
}
export function readRegistry(file = registryPath()): {
  projects: RegisteredProject[];
  revision: string;
} {
  try {
    const raw = readFileSync(file, "utf8"),
      parsed = registrySchema.parse(JSON.parse(raw));
    const roots = new Set<string>();
    for (const p of parsed.projects) {
      p.root = canonical(p.root);
      if (roots.has(p.root)) throw new Error("duplicate root");
      roots.add(p.root);
    }
    return { projects: parsed.projects, revision: createHash("sha256").update(raw).digest("hex") };
  } catch {
    throw new ProjectRegistryError("project_registry_invalid");
  }
}
export function resolveRegisteredProject(
  cwd: string,
  file = registryPath()
): RegisteredProject & { revision: string } {
  if (!existsSync(cwd)) throw new ProjectRegistryError("project_directory_missing");
  const path = originalProjectPath(cwd),
    registry = readRegistry(file);
  const match = registry.projects
    .filter((p) => within(path, p.root))
    .sort((a, b) => b.root.length - a.root.length)[0];
  if (!match) throw new ProjectRegistryError("project_unregistered");
  if (!match.enabled) throw new ProjectRegistryError("project_disabled");
  return { ...match, revision: registry.revision };
}
export function assertProjectBinding(cwd: string, bank: string, file = registryPath()): void {
  if (resolveRegisteredProject(cwd, file).bankId !== bank)
    throw new ProjectRegistryError("project_mapping_changed");
}
/** Later sources override earlier ones, matching the former DSH runtime registry. */
export function importProjects(
  sources: string[],
  enabledBanks: readonly string[],
  output: string
): RegisteredProject[] {
  const legacy = z.object({
    projects: z.array(
      z.object({
        root: z.string(),
        bankId: z.string().optional(),
        wikiName: z.string().optional(),
        wiki_name: z.string().optional(),
        name: z.string().optional(),
        project: z.string().optional(),
        kind: z.string().optional(),
      })
    ),
  });
  const entries = new Map<string, RegisteredProject>();
  for (const file of sources)
    for (const p of legacy.parse(JSON.parse(readFileSync(file, "utf8"))).projects) {
      if (p.kind === "mirror") continue;
      const root = canonical(p.root),
        bankId = p.bankId || p.wikiName || p.wiki_name;
      if (!bankId) throw new ProjectRegistryError("project_bank_missing");
      entries.set(root, {
        root,
        bankId,
        name: p.name || p.project,
        enabled: enabledBanks.includes(bankId),
      });
    }
  if (existsSync(output)) throw new ProjectRegistryError("registry_already_exists");
  const projects = [...entries.values()].sort((a, b) => a.root.localeCompare(b.root));
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  // Exclusive creation protects an existing registry, including a concurrent import.
  writeFileSync(output, JSON.stringify({ projects }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return projects;
}
