/** Process-wide rollout switches; set before starting the MCP server (restart to change). */
const typesMode = process.env.RECALL_DEFAULT_TYPES ?? "new";
if (typesMode !== "new" && typesMode !== "legacy") throw new Error("invalid_recall_default_types");
export const RECALL_DEFAULT_TYPES_MODE: "new" | "legacy" = typesMode;

const guidanceVersion = process.env.GUIDANCE_VERSION ?? "v4";
if (guidanceVersion !== "v4" && guidanceVersion !== "v1")
  throw new Error("invalid_guidance_version");
export const GUIDANCE_VERSION: "v4" | "v1" = guidanceVersion;
