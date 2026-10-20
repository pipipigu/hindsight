/** Memory permissions are separate from the agent's filesystem/sandbox permissions. */
export type MemoryAccess = "read-write" | "read-only";

export const READ_ONLY_MEMORY_GUIDANCE =
  "当前子代理的记忆权限为只读：可以查询和读取记忆，不能保存结论或导入文档；请将结论与依据交回主会话整理保存。";

export function memoryAccessFor(origin?: string): MemoryAccess {
  const access = process.env.HINDSIGHT_MEMORY_ACCESS;
  // A launcher supplies this only to its child MCP/worker process. Unknown nonempty values
  // fail closed; neither a normal sandbox nor a tool argument can raise this permission.
  return origin === "subagent" || (access !== undefined && access !== "" && access !== "read-write")
    ? "read-only"
    : "read-write";
}

export function assertMemoryWritable(access: MemoryAccess = memoryAccessFor()): void {
  if (access === "read-only" || memoryAccessFor() === "read-only")
    throw new Error("memory_readonly");
}
