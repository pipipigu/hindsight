#!/usr/bin/env node
import { importProjects, readRegistry, registryPath } from "./core/project-registry";

const args = process.argv.slice(2),
  action = args.shift();
try {
  if (action === "import") {
    const i = args.indexOf("--output"),
      output = i >= 0 ? args.splice(i, 2)[1] : registryPath();
    if (!args.length || !output)
      throw new Error("Usage: project-registry import BASELINE RUNTIME [--output FILE]");
    const projects = importProjects(args, ["p-dsh", "p-ybd-sq", "p-rg", "p-chatgpt"], output);
    process.stdout.write(
      JSON.stringify({
        output,
        projects: projects.length,
        enabled: projects.filter((p) => p.enabled).length,
      }) + "\n"
    );
  } else if (action === "list")
    process.stdout.write(JSON.stringify(readRegistry(args[0]).projects, null, 2) + "\n");
  else throw new Error("Usage: project-registry import|list");
} catch (e) {
  console.error(e instanceof Error ? e.message : "registry_error");
  process.exitCode = 1;
}
