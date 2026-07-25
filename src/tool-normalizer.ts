/**
 * Maps qodercli tool names to opencode tool names and normalizes their inputs.
 *
 * - Casing: Read -> read, Bash -> bash
 * - Builtins: AskUserQuestion -> question, Agent -> task, ExitPlanMode -> plan_exit
 * - MCP proxy: mcp__{server}__{tool} -> {server}_{tool}
 */

const NAME_MAP: Record<string, string> = {
  askuserquestion: "question",
  agent: "task",
  exitplanmode: "plan_exit",
  str_replace_based_edit_tool: "edit",
};

const KEY_RENAMES: Record<string, Record<string, string>> = {
  read: { file_path: "filePath" },
  write: { file_path: "filePath" },
  task: { subagentType: "subagent_type" },
  edit: {
    file_path: "filePath",
    old_string: "oldString",
    new_string: "newString",
    replace_all: "replaceAll",
  },
  skill: { skill: "name" },
};

const SUBAGENT_TYPE_MAP: Record<string, string> = {
  "general-purpose": "general",
  "general_purpose": "general",
  "general purpose": "general",
  "code-reviewer": "general",
  "task-executor": "general",
  "design-agent": "general",
  "spec-review-agent": "explore",
  "qoder-guide": "explore",
  explorer: "explore",
};
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function normalizeToolName(name: string): string {
  const lower = name.toLowerCase();
  const mapped = Object.hasOwn(NAME_MAP, lower) ? NAME_MAP[lower] : undefined;
  if (mapped) return mapped;

  if (lower.startsWith("mcp__")) {
    const rest = lower.slice(5);
    const sep = rest.indexOf("__");
    if (sep > 0) return `${rest.slice(0, sep)}_${rest.slice(sep + 2)}`;
    return rest;
  }

  return lower;
}

/** Normalize a parsed tool-input object for the given (already normalized) tool name. */
export function normalizeToolInput(toolName: string, input: unknown): unknown {
  if (!isRecord(input)) return input;

  const renames = Object.hasOwn(KEY_RENAMES, toolName) ? KEY_RENAMES[toolName] : undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (UNSAFE_KEYS.has(k)) continue;
    const renamed = renames && Object.hasOwn(renames, k) ? renames[k] : k;
    if (!UNSAFE_KEYS.has(renamed)) out[renamed] = v;
  }

  if (toolName === "task" && typeof out.subagent_type === "string") {
    const type = out.subagent_type.trim().toLowerCase();
    out.subagent_type = Object.hasOwn(SUBAGENT_TYPE_MAP, type) ? SUBAGENT_TYPE_MAP[type] : type;
  }

  if (toolName === "grep") {
    if (typeof out.include !== "string") {
      const glob = out.glob;
      const type = out.type;
      if (typeof glob === "string") out.include = glob;
      else if (typeof type === "string") out.include = `*.${type}`;
    }
    for (const k of ["glob", "type", "output_mode", "multiline", "head_limit", "-i", "-n", "-B", "-A", "-C"]) {
      delete out[k];
    }
  }

  return out;
}

/** Parse a JSON input string, normalize, and re-serialize. Falls back to the original on parse error. */
export function normalizeToolInputString(toolName: string, input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "{}";
  try {
    return JSON.stringify(normalizeToolInput(toolName, JSON.parse(trimmed)));
  } catch {
    return input;
  }
}
