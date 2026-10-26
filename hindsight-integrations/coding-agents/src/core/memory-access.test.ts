import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertMemoryWritable, memoryAccessFor } from "./memory-access";

beforeEach(() => vi.stubEnv("HINDSIGHT_MEMORY_ACCESS", ""));
afterEach(() => vi.unstubAllEnvs());

describe("memory access authority", () => {
  it("preserves standalone sessions and makes subagents read-only", () => {
    expect(memoryAccessFor()).toBe("read-write");
    expect(memoryAccessFor("main")).toBe("read-write");
    expect(memoryAccessFor("subagent")).toBe("read-only");
    expect(() => assertMemoryWritable()).not.toThrow();
    expect(() => assertMemoryWritable("read-write")).not.toThrow();
    expect(() => assertMemoryWritable("read-only")).toThrow("memory_readonly");
  });

  it("does not let an explicit writable environment elevate a subagent", () => {
    vi.stubEnv("HINDSIGHT_MEMORY_ACCESS", "read-write");
    expect(memoryAccessFor()).toBe("read-write");
    expect(memoryAccessFor("subagent")).toBe("read-only");
    expect(() => assertMemoryWritable("read-only")).toThrow("memory_readonly");
  });

  it.each(["read-only", "readonly", "unknown", "READ-WRITE", " "])(
    "fails closed for inherited environment %j, including explicit writable arguments",
    (value) => {
      vi.stubEnv("HINDSIGHT_MEMORY_ACCESS", value);
      expect(memoryAccessFor()).toBe("read-only");
      expect(memoryAccessFor("main")).toBe("read-only");
      expect(memoryAccessFor("subagent")).toBe("read-only");
      expect(() => assertMemoryWritable()).toThrow("memory_readonly");
      expect(() => assertMemoryWritable("read-write")).toThrow("memory_readonly");
    }
  );

  it("re-evaluates authority instead of caching another session's access", () => {
    expect(memoryAccessFor("subagent")).toBe("read-only");
    expect(memoryAccessFor()).toBe("read-write");
    vi.stubEnv("HINDSIGHT_MEMORY_ACCESS", "read-only");
    expect(memoryAccessFor()).toBe("read-only");
    vi.stubEnv("HINDSIGHT_MEMORY_ACCESS", "read-write");
    expect(memoryAccessFor()).toBe("read-write");
    expect(memoryAccessFor("subagent")).toBe("read-only");
  });
});
