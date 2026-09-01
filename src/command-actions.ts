import { forkSession, listSessions } from "@qoder-ai/qoder-agent-sdk";
import type { Query } from "@qoder-ai/qoder-agent-sdk";
import { listModels } from "./models.js";
import type { ModelDiscoveryOptions } from "./models.js";
import { getLiveUsage, formatUsageReport } from "./usage.js";
import { summarize, formatCost } from "./cost.js";
import { clearAllSessions, deleteQoderSessionForCwd, getQoderSessionForCwd } from "./session-store.js";
import { describeError } from "./logger.js";
import { formatMcpStatuses, openSdkControlSession, withMcpControlTimeout } from "./sdk-control.js";
import type { QoderBridgeOptions } from "./types.js";

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
const CONTROL_CHAR_TEST = /[\u0000-\u001f\u007f-\u009f]/;
const MAX_ARGUMENTS = 32_768;
const MCP_AUTH_TTL_MS = 10 * 60 * 1000;

export const QODER_COMMANDS = [
  {
    name: "qoder_usage",
    title: "Qoder Usage",
    description: "Show live Qoder quota and local cost/token totals.",
    argumentHint: "",
  },
  {
    name: "qoder_models",
    title: "Qoder Models",
    description: "List available Qoder models and capabilities.",
    argumentHint: "",
  },
  {
    name: "qoder_sessions",
    title: "Qoder Sessions",
    description: "List recent Qoder sessions.",
    argumentHint: "optional: [directory] [limit]",
  },
  {
    name: "qoder_session_reset",
    title: "Reset Qoder Session",
    description: "Reset a persisted Qoder session key, or all sessions.",
    argumentHint: "optional: session key or all",
  },
  {
    name: "qoder_session_fork",
    title: "Fork Qoder Session",
    description: "Fork a Qoder session without changing the active mapping.",
    argumentHint: "optional: sessionId dir title upToMessageId",
  },
  {
    name: "qoder_mcp_status",
    title: "Qoder MCP Status",
    description: "Inspect Qoder MCP connection and OAuth status.",
    argumentHint: "",
  },
  {
    name: "qoder_mcp_auth",
    title: "Qoder MCP OAuth",
    description: "Start or complete Qoder MCP OAuth.",
    argumentHint: "server [callbackUrl] [redirectUri]",
  },
  {
    name: "qoder_plan_mode",
    title: "Qoder Plan Mode",
    description: "Show Qoder Plan Mode status and configuration guidance.",
    argumentHint: "",
  },
] as const;

export type QoderCommandName = (typeof QODER_COMMANDS)[number]["name"];

export type CommandResult = {
  title: string;
  output: string;
  variant?: "info" | "success" | "warning" | "error";
};

export type PendingMcpAuth = {
  query: Query;
  close: () => Promise<void>;
  timer: ReturnType<typeof setTimeout>;
};

export type QoderCommandContext = {
  configuredCwd: string;
  configuredSessionKey?: string;
  configuredSessionId?: string;
  configuredBridgeOptions: QoderBridgeOptions;
  modelEnvironment?: Record<string, string | undefined>;
  modelOptions?: ModelDiscoveryOptions;
  pendingMcpAuth: Map<string, PendingMcpAuth>;
};

export type QoderSessionsArguments = {
  dir?: string;
  limit?: number;
};

export type QoderSessionForkArguments = {
  sessionId?: string;
  dir?: string;
  title?: string;
  upToMessageId?: string;
};

export type QoderMcpAuthArguments = {
  server: string;
  callbackUrl?: string;
  redirectUri?: string;
};

export function safeDisplay(value: unknown, fallback: string, maxLength = 512): string {
  if (typeof value !== "string" || !value) return fallback;
  const clean = value.replace(CONTROL_CHARS, " ").slice(0, maxLength);
  return clean || fallback;
}

export async function closePendingMcpAuth(
  pendingMcpAuth: Map<string, PendingMcpAuth>,
  serverName: string,
): Promise<void> {
  const pending = pendingMcpAuth.get(serverName);
  if (!pending) return;
  pendingMcpAuth.delete(serverName);
  clearTimeout(pending.timer);
  await pending.close();
}

export async function closeAllPendingMcpAuth(
  pendingMcpAuth: Map<string, PendingMcpAuth>,
): Promise<void> {
  const names = [...pendingMcpAuth.keys()];
  await Promise.all(names.map(async (name) => {
    try {
      await closePendingMcpAuth(pendingMcpAuth, name);
    } catch {
      // Best-effort cleanup during plugin shutdown.
    }
  }));
}

async function savePendingMcpAuth(
  pendingMcpAuth: Map<string, PendingMcpAuth>,
  serverName: string,
  session: { query: Query; close: () => Promise<void> },
): Promise<void> {
  await closePendingMcpAuth(pendingMcpAuth, serverName);
  const pending: PendingMcpAuth = {
    query: session.query,
    close: session.close,
    timer: undefined as unknown as ReturnType<typeof setTimeout>,
  };
  const timer = setTimeout(() => {
    if (pendingMcpAuth.get(serverName) !== pending) return;
    pendingMcpAuth.delete(serverName);
    void pending.close().catch(() => undefined);
  }, MCP_AUTH_TTL_MS);
  if (typeof timer.unref === "function") timer.unref();
  pending.timer = timer;
  pendingMcpAuth.set(serverName, pending);
}

export async function runQoderUsage(_context: QoderCommandContext): Promise<CommandResult> {
  try {
    const lines: string[] = [];
    const live = await getLiveUsage();
    lines.push(live ? formatUsageReport(live) : "Live usage unavailable (not logged in or Qoder runtime unavailable).");

    const summary = summarize();
    lines.push("");
    lines.push("Local Cost Ledger");
    lines.push(`  Total cost: ${formatCost(summary.totalCostUsd)}`);
    lines.push(`  Turns: ${summary.turnCount}`);
    lines.push(`  Tokens: ${summary.totalInputTokens} in / ${summary.totalOutputTokens} out`);

    const models = Object.entries(summary.byModel);
    if (models.length > 0) {
      lines.push("  By model:");
      for (const [name, bucket] of models) {
        lines.push(`    ${name}: ${formatCost(bucket.costUsd)} (${bucket.turns} turns)`);
      }
    }

    return { title: "Qoder Usage", output: lines.join("\n") };
  } catch (error) {
    return { title: "Qoder Usage", output: `Failed to load usage: ${describeError(error)}`, variant: "error" };
  }
}

export async function runQoderModels(context: QoderCommandContext): Promise<CommandResult> {
  try {
    const models = listModels(context.modelEnvironment ?? process.env, context.modelOptions ?? {});
    const lines = ["Qoder Models"];
    for (const model of models) {
      lines.push(`  ${safeDisplay(model.id, "unknown", 256)}: ${safeDisplay(model.name, "unknown", 512)}`);
      lines.push(`    context ${model.limit.context}, output ${model.limit.output}, price ${model.multiplier}x`);
      lines.push(`    vision ${model.attachment ? "yes" : "no"}, reasoning ${model.reasoning ? "yes" : "no"}`);
    }
    return { title: "Qoder Models", output: lines.join("\n") };
  } catch (error) {
    return { title: "Qoder Models", output: `Failed to list models: ${describeError(error)}`, variant: "error" };
  }
}

export async function runQoderSessions(
  _context: QoderCommandContext,
  input: QoderSessionsArguments = {},
): Promise<CommandResult> {
  try {
    const limit = typeof input.limit === "number" && input.limit > 0 ? input.limit : 10;
    const dir = typeof input.dir === "string" && input.dir.trim() ? input.dir.trim() : undefined;
    const sessionsResult = await listSessions({
      limit: Math.max(1, Math.min(100, Math.floor(limit))),
      ...(dir ? { dir } : {}),
    });
    const sessions = Array.isArray(sessionsResult) ? sessionsResult : [];
    if (sessions.length === 0) return { title: "Qoder Sessions", output: "No recent Qoder sessions found." };

    const lines: string[] = ["Recent Qoder Sessions"];
    for (const session of sessions) {
      const item: Record<string, unknown> = isRecord(session) ? session : {};
      const sessionId = safeDisplay(item.sessionId, "unknown", 256);
      const title = typeof item.customTitle === "string" && item.customTitle
        ? safeDisplay(item.customTitle, sessionId, 512)
        : typeof item.summary === "string" && item.summary
          ? safeDisplay(item.summary, sessionId, 512)
          : sessionId;
      const lastModified = item.lastModified;
      const dateValue = typeof lastModified === "string" || typeof lastModified === "number"
        ? new Date(lastModified)
        : null;
      const date = dateValue && !Number.isNaN(dateValue.getTime()) ? dateValue.toLocaleString() : "unknown";
      const branch = safeDisplay(item.gitBranch, "n/a", 256);
      const cwd = safeDisplay(item.cwd, "n/a", 1024);
      lines.push(`- [${sessionId.slice(0, 8)}] ${title}`);
      lines.push(`    Updated: ${date} | Branch: ${branch} | Path: ${cwd}`);
    }
    return { title: "Qoder Sessions", output: lines.join("\n") };
  } catch (error) {
    return { title: "Qoder Sessions", output: `Failed to list sessions: ${describeError(error)}`, variant: "error" };
  }
}

export async function runQoderSessionReset(
  context: QoderCommandContext,
  key?: string,
): Promise<CommandResult> {
  try {
    const target = typeof key === "string" && key.trim() ? key.trim() : context.configuredSessionKey;
    if (!target) {
      return {
        title: "Qoder Session",
        output: "No session key specified and none configured. Provide a key or use 'all' to reset all sessions.",
        variant: "warning",
      };
    }
    if (target.toLowerCase() === "all") {
      await clearAllSessions();
      return { title: "Qoder Session", output: "Reset all persisted Qoder sessions.", variant: "success" };
    }
    await deleteQoderSessionForCwd(target, context.configuredCwd, context.configuredSessionId || target);
    return {
      title: "Qoder Session",
      output: `Reset persisted Qoder session: ${safeDisplay(target, "unknown", 512)}`,
      variant: "success",
    };
  } catch (error) {
    return { title: "Qoder Session", output: `Failed to reset session: ${describeError(error)}`, variant: "error" };
  }
}

export async function runQoderSessionFork(
  context: QoderCommandContext,
  input: QoderSessionForkArguments = {},
): Promise<CommandResult> {
  try {
    const requestedId = typeof input.sessionId === "string" ? input.sessionId.trim() : "";
    const dir = typeof input.dir === "string" && input.dir.trim() ? input.dir.trim() : context.configuredCwd;
    let sourceId = requestedId || context.configuredSessionId;
    if (!sourceId && context.configuredSessionKey) {
      const persisted = await getQoderSessionForCwd(context.configuredSessionKey, dir);
      sourceId = persisted?.qoderSessionId;
    }
    if (!sourceId) {
      return {
        title: "Qoder Session Fork",
        output: "No source session ID is available. Provide sessionId or configure session persistence first.",
        variant: "warning",
      };
    }
    const title = typeof input.title === "string" && input.title.trim() ? input.title.trim() : undefined;
    const upToMessageId = typeof input.upToMessageId === "string" && input.upToMessageId.trim()
      ? input.upToMessageId.trim()
      : undefined;
    const forked = await forkSession(sourceId, {
      dir,
      ...(title ? { title } : {}),
      ...(upToMessageId ? { upToMessageId } : {}),
    });
    return {
      title: "Qoder Session Fork",
      output: [
        `Forked session ${safeDisplay(sourceId, "unknown", 256)}.`,
        `New session ID: ${safeDisplay(forked.sessionId, "unknown", 256)}`,
        "The active provider mapping was left unchanged; use the new ID as sessionId when you want to continue the fork.",
      ].join("\n"),
      variant: "success",
    };
  } catch (error) {
    return { title: "Qoder Session Fork", output: `Failed to fork session: ${describeError(error)}`, variant: "error" };
  }
}

export async function runQoderMcpStatus(context: QoderCommandContext): Promise<CommandResult> {
  let control: Awaited<ReturnType<typeof openSdkControlSession>> | undefined;
  try {
    control = await openSdkControlSession(context.configuredBridgeOptions, context.configuredCwd);
    const statuses = await withMcpControlTimeout(control.query.mcpServerStatus(), "status request");
    return { title: "Qoder MCP Status", output: formatMcpStatuses(statuses) };
  } catch (error) {
    return { title: "Qoder MCP Status", output: `Failed to inspect MCP status: ${describeError(error)}`, variant: "error" };
  } finally {
    if (control) await control.close();
  }
}

export async function runQoderMcpAuth(
  context: QoderCommandContext,
  input: QoderMcpAuthArguments,
): Promise<CommandResult> {
  const serverName = typeof input.server === "string" ? input.server.trim() : "";
  const callbackUrl = typeof input.callbackUrl === "string" ? input.callbackUrl.trim() : "";
  const redirectUri = typeof input.redirectUri === "string" ? input.redirectUri.trim() : "";
  if (!serverName || serverName.length > 256 || CONTROL_CHAR_TEST.test(serverName)) {
    return { title: "Qoder MCP OAuth", output: "Provide a valid MCP server name.", variant: "warning" };
  }
  if (callbackUrl && (callbackUrl.length > 16_384 || CONTROL_CHAR_TEST.test(callbackUrl))) {
    return { title: "Qoder MCP OAuth", output: "The callback URL is invalid or too long.", variant: "warning" };
  }
  if (redirectUri && (redirectUri.length > 16_384 || CONTROL_CHAR_TEST.test(redirectUri))) {
    return { title: "Qoder MCP OAuth", output: "The redirect URI is invalid or too long.", variant: "warning" };
  }

  const pending = context.pendingMcpAuth.get(serverName);
  if (callbackUrl && !pending) {
    return {
      title: "Qoder MCP OAuth",
      output: `No pending OAuth flow for ${safeDisplay(serverName, "unknown")}. Call qoder_mcp_auth without callbackUrl first, then authorize using the returned URL.`,
      variant: "warning",
    };
  }

  if (callbackUrl && pending) {
    try {
      await withMcpControlTimeout(
        pending.query.mcpSubmitOAuthCallbackUrl(serverName, callbackUrl),
        "OAuth callback",
      );
      context.pendingMcpAuth.delete(serverName);
      clearTimeout(pending.timer);
      await pending.close();
      return {
        title: "Qoder MCP OAuth",
        output: `OAuth authentication completed for ${safeDisplay(serverName, "unknown")}. Run qoder_mcp_status to verify the connection.`,
        variant: "success",
      };
    } catch (error) {
      return {
        title: "Qoder MCP OAuth",
        output: `OAuth callback failed: ${describeError(error)} The pending flow was retained for another callback attempt.`,
        variant: "error",
      };
    }
  }

  await closePendingMcpAuth(context.pendingMcpAuth, serverName);
  let control: Awaited<ReturnType<typeof openSdkControlSession>> | undefined;
  try {
    control = await openSdkControlSession(context.configuredBridgeOptions, context.configuredCwd);
    const result = await withMcpControlTimeout(
      control.query.mcpAuthenticate(serverName, redirectUri || undefined),
      "OAuth authentication",
    );
    if (!result.requiresUserAction) {
      await control.close();
      control = undefined;
      return {
        title: "Qoder MCP OAuth",
        output: `${safeDisplay(serverName, "unknown")} is already authenticated (or was refreshed silently).`,
        variant: "success",
      };
    }
    if (!result.authUrl) {
      await control.close();
      control = undefined;
      return {
        title: "Qoder MCP OAuth",
        output: `Qoder requires user action for ${safeDisplay(serverName, "unknown")}, but did not return an authorization URL.`,
        variant: "warning",
      };
    }
    await savePendingMcpAuth(context.pendingMcpAuth, serverName, control);
    control = undefined;
    return {
      title: "Qoder MCP OAuth",
      output: [
        `Authorize ${safeDisplay(serverName, "unknown")} by opening this URL:`,
        safeDisplay(result.authUrl, "(authorization URL unavailable)", 16_384),
        "After the redirect, call qoder_mcp_auth again with the same server and the complete callbackUrl.",
        `The pending flow expires in ${Math.round(MCP_AUTH_TTL_MS / 60_000)} minutes.`,
      ].join("\n"),
    };
  } catch (error) {
    return { title: "Qoder MCP OAuth", output: `Failed to start OAuth: ${describeError(error)}`, variant: "error" };
  } finally {
    if (control) await control.close();
  }
}

export function runQoderPlanMode(): CommandResult {
  const lines = [
    "Qoder Plan Mode",
    "Plan Mode instructs Qoder to analyze and plan changes without modifying files or running tool actions.",
    "",
    "Configuration in ~/.config/opencode/opencode.json:",
    "  \"provider\": {",
    "    \"qoder\": {",
    "      \"options\": {",
    "        \"planMode\": true",
    "      }",
    "    }",
    "  }",
    "",
    "Plan Mode operates independently from tool permissions, preserving your underlying permission mode.",
  ];
  return { title: "Qoder Plan Mode", output: lines.join("\n") };
}

export async function executeQoderCommand(
  name: string,
  rawArguments: string,
  context: QoderCommandContext,
): Promise<CommandResult> {
  if (typeof rawArguments !== "string" || rawArguments.length > MAX_ARGUMENTS || CONTROL_CHAR_TEST.test(rawArguments)) {
    return { title: "Qoder Command", output: "Command arguments are invalid or too long.", variant: "error" };
  }
  switch (name) {
    case "qoder_usage":
      return runQoderUsage(context);
    case "qoder_models":
      return runQoderModels(context);
    case "qoder_sessions": {
      const parsed = parseSessionsArguments(rawArguments);
      return parsed.error ? parsed.error : runQoderSessions(context, parsed.value);
    }
    case "qoder_session_reset": {
      const parsed = parseResetArguments(rawArguments);
      return parsed.error ? parsed.error : runQoderSessionReset(context, parsed.value);
    }
    case "qoder_session_fork": {
      const parsed = parseForkArguments(rawArguments);
      return parsed.error ? parsed.error : runQoderSessionFork(context, parsed.value);
    }
    case "qoder_mcp_status":
      return runQoderMcpStatus(context);
    case "qoder_mcp_auth": {
      const parsed = parseMcpAuthArguments(rawArguments);
      return parsed.error ? parsed.error : runQoderMcpAuth(context, parsed.value);
    }
    case "qoder_plan_mode":
      return runQoderPlanMode();
    default:
      return { title: "Qoder Command", output: `Unknown Qoder command: ${safeDisplay(name, "unknown")}`, variant: "error" };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type ParseResult<T> = { value: T; error?: undefined } | { value?: undefined; error: CommandResult };

function parseTokens(raw: string): ParseResult<string[]> {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index];
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else if (char === "\\" && quote === '"' && index + 1 < raw.length && raw[index + 1] === '"') {
        current += '"';
        index++;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
    } else if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (quote) return { error: { title: "Qoder Command", output: "Unclosed quote in command arguments.", variant: "error" } };
  if (current) tokens.push(current);
  return { value: tokens };
}

function parseSessionsArguments(raw: string): ParseResult<QoderSessionsArguments> {
  const tokenResult = parseTokens(raw);
  if (tokenResult.error) return tokenResult;
  const tokens = tokenResult.value;
  let dir: string | undefined;
  let limit: number | undefined;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index] ?? "";
    const dirMatch = token.match(/^--dir=(.+)$/);
    const limitMatch = token.match(/^--limit=(.+)$/);
    if (dirMatch) {
      if (dir) return invalidArguments("Only one sessions directory may be supplied.");
      dir = dirMatch[1];
      continue;
    }
    if (limitMatch) {
      if (limit !== undefined) return invalidArguments("Only one sessions limit may be supplied.");
      limit = parsePositiveInteger(limitMatch[1]);
      if (limit === undefined) return invalidArguments("Sessions limit must be a positive integer.");
      continue;
    }
    if (token === "--dir") {
      const value = tokens[++index];
      if (!value || dir) return invalidArguments("Provide one valid sessions directory.");
      dir = value;
      continue;
    }
    if (token === "--limit" || token === "-n") {
      const value = tokens[++index];
      if (!value || limit !== undefined) return invalidArguments("Provide one positive sessions limit.");
      limit = parsePositiveInteger(value);
      if (limit === undefined) return invalidArguments("Sessions limit must be a positive integer.");
      continue;
    }
    if (/^\d+$/.test(token) && limit === undefined) {
      limit = parsePositiveInteger(token);
      if (limit === undefined) return invalidArguments("Sessions limit must be a positive integer.");
      continue;
    }
    if (!dir) {
      dir = token;
      continue;
    }
    return invalidArguments("Use qoder_sessions as [directory] [limit], or --dir and --limit.");
  }
  return { value: { ...(dir ? { dir } : {}), ...(limit !== undefined ? { limit } : {}) } };
}

function parseResetArguments(raw: string): ParseResult<string | undefined> {
  const tokenResult = parseTokens(raw);
  if (tokenResult.error) return tokenResult;
  if (tokenResult.value.length > 1) return invalidArguments("Use qoder_session_reset with one session key or 'all'.");
  return { value: tokenResult.value[0] };
}

function parseForkArguments(raw: string): ParseResult<QoderSessionForkArguments> {
  if (raw.trim().startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed)) return invalidArguments("Fork JSON arguments must be an object.");
      return { value: normalizeForkObject(parsed) };
    } catch {
      return invalidArguments("Fork JSON arguments are invalid.");
    }
  }
  const tokenResult = parseTokens(raw);
  if (tokenResult.error) return tokenResult;
  const tokens = tokenResult.value;
  const positional: string[] = [];
  const result: QoderSessionForkArguments = {};
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index] ?? "";
    const equals = token.indexOf("=");
    if (equals > 0) {
      const key = token.slice(0, equals);
      const value = token.slice(equals + 1);
      if (!setForkField(result, key, value)) return invalidArguments(`Unknown fork argument: ${key}`);
      continue;
    }
    const option = forkOption(token);
    if (option) {
      const value = tokens[++index];
      if (!value || !setForkField(result, option, value)) return invalidArguments(`Missing value for ${token}.`);
      continue;
    }
    positional.push(token);
  }
  const fields: (keyof QoderSessionForkArguments)[] = ["sessionId", "dir", "title", "upToMessageId"];
  for (let index = 0; index < positional.length; index++) {
    const field = fields[index];
    if (!field || result[field] !== undefined) return invalidArguments("Fork arguments are ambiguous; use key=value fields.");
    result[field] = positional[index];
  }
  return { value: result };
}

function parseMcpAuthArguments(raw: string): ParseResult<QoderMcpAuthArguments> {
  const tokenResult = parseTokens(raw);
  if (tokenResult.error) return tokenResult;
  const tokens = tokenResult.value;
  let server = "";
  let callbackUrl: string | undefined;
  let redirectUri: string | undefined;
  const positional: string[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index] ?? "";
    const equals = token.indexOf("=");
    if (equals > 0) {
      const key = token.slice(0, equals);
      const value = token.slice(equals + 1);
      if (key === "server") server = value;
      else if (key === "callbackUrl" || key === "callback-url") callbackUrl = value;
      else if (key === "redirectUri" || key === "redirect-uri") redirectUri = value;
      else return invalidArguments(`Unknown MCP OAuth argument: ${key}`);
      continue;
    }
    const option = token === "--callback-url" ? "callbackUrl" : token === "--redirect-uri" ? "redirectUri" : undefined;
    if (option) {
      const value = tokens[++index];
      if (!value) return invalidArguments(`Missing value for ${token}.`);
      if (option === "callbackUrl") callbackUrl = value;
      else redirectUri = value;
      continue;
    }
    positional.push(token);
  }
  if (!server) server = positional.shift() ?? "";
  if (callbackUrl === undefined) callbackUrl = positional.shift();
  if (redirectUri === undefined) redirectUri = positional.shift();
  if (positional.length > 0) return invalidArguments("Use qoder_mcp_auth as server [callbackUrl] [redirectUri].");
  return { value: { server, ...(callbackUrl ? { callbackUrl } : {}), ...(redirectUri ? { redirectUri } : {}) } };
}

function normalizeForkObject(value: Record<string, unknown>): QoderSessionForkArguments {
  return {
    ...(stringValue(value.sessionId) ? { sessionId: stringValue(value.sessionId) } : {}),
    ...(stringValue(value.dir) ? { dir: stringValue(value.dir) } : {}),
    ...(stringValue(value.title) ? { title: stringValue(value.title) } : {}),
    ...(stringValue(value.upToMessageId) ? { upToMessageId: stringValue(value.upToMessageId) } : {}),
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function setForkField(target: QoderSessionForkArguments, key: string, value: string): boolean {
  const field = forkOption(key) ?? (key === "sessionId" || key === "dir" || key === "title" || key === "upToMessageId" ? key : undefined);
  if (!field || !value) return false;
  target[field] = value;
  return true;
}

function forkOption(value: string): keyof QoderSessionForkArguments | undefined {
  switch (value) {
    case "--session-id":
    case "--sessionId":
    case "id":
    case "sessionId":
      return "sessionId";
    case "--dir":
    case "dir":
      return "dir";
    case "--title":
    case "title":
      return "title";
    case "--up-to-message-id":
    case "--upToMessageId":
    case "upToMessageId":
    case "cutoff":
      return "upToMessageId";
    default:
      return undefined;
  }
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function invalidArguments(output: string): ParseResult<never> {
  return { error: { title: "Qoder Command", output, variant: "error" } };
}
