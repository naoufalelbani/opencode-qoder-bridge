import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, resolve } from "node:path";

const CHARS_PER_TOKEN = 4;
const BUDGET_RATIO = 0.7;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_BASE64_CHARS = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4;
const IMAGE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

type PromptMessage = { role: string; content: unknown };

type TextBlock = { type: "text"; text: string };
type ImageBlock = {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
};

export type SdkUserMessage = {
  type: "user";
  session_id: string;
  parent_tool_use_id: null;
  message: { role: "user"; content: Array<TextBlock | ImageBlock> };
};

const TAG_END = (name: string): string => "<" + "/" + name + ">";

function approxTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const out: string[] = [];
  for (const part of content) {
    const p = part as { type?: string; text?: string };
    if (p.type === "text" && p.text) out.push(p.text);
  }
  return out.join("\n");
}

function extractUserText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    const p = part as { type?: string; text?: string; mimeType?: string; mediaType?: string };
    if (p.type === "text" && p.text) parts.push(p.text);
    else if (p.type === "image") parts.push(`[Image attached: ${p.mimeType ?? "image"}]`);
    else if (p.type === "file" && typeof p.mediaType === "string" && p.mediaType.startsWith("image/"))
      parts.push(`[Image attached: ${p.mediaType}]`);
  }
  return parts.join("\n");
}

function serializeToolOutput(output: unknown): string {
  if (output == null) return "";
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) return JSON.stringify(output, null, 2);
  const parts: string[] = [];
  for (const item of output) {
    if (item && typeof item === "object" && "type" in item) {
      const it = item as { type: string; value?: unknown };
      if (it.type === "text") parts.push(String(it.value ?? ""));
      else if (it.type === "json") parts.push(JSON.stringify(it.value, null, 2));
      else if (it.type === "error-text") parts.push(`[Error] ${String(it.value ?? "")}`);
      else parts.push(JSON.stringify(item, null, 2));
      continue;
    }
    parts.push(JSON.stringify(item, null, 2));
  }
  return parts.join("\n");
}

function serializeMessage(msg: PromptMessage): string {
  switch (msg.role) {
    case "system": {
      const text = extractText(msg.content);
      return text ? `<system>\n${text}\n${TAG_END("system")}` : "";
    }
    case "user":
      return extractUserText(msg.content);
    case "assistant": {
      if (!Array.isArray(msg.content)) return "";
      const parts: string[] = [];
      for (const part of msg.content) {
        const p = part as { type?: string; text?: string; toolCallId?: string; toolName?: string; input?: unknown };
        if (p.type === "text" && p.text) parts.push(p.text);
        else if (p.type === "tool-call") {
          const input = typeof p.input === "string" ? p.input : JSON.stringify(p.input ?? {});
          parts.push(`<tool_call id="${p.toolCallId}" name="${p.toolName}">\n${input}\n${TAG_END("tool_call")}`);
        }
      }
      return parts.length > 0 ? `<assistant>\n${parts.join("\n")}\n${TAG_END("assistant")}` : "";
    }
    case "tool": {
      if (!Array.isArray(msg.content)) return "";
      const parts: string[] = [];
      for (const part of msg.content) {
        const p = part as { type?: string; toolCallId?: string; toolName?: string; output?: unknown };
        if (p.type === "tool-result") {
          parts.push(`<tool_result id="${p.toolCallId}" name="${p.toolName}">\n${serializeToolOutput(p.output)}\n${TAG_END("tool_result")}`);
        }
      }
      return parts.join("\n");
    }
    default:
      return "";
  }
}

function inferMediaType(filePath: string): string {
  const map: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
  };
  return map[extname(filePath).toLowerCase()] ?? "image/jpeg";
}

function readLocalBase64(pathOrUrl: string): string | null {
  try {
    let filePath: string;
    if (pathOrUrl.startsWith("file://")) filePath = decodeURIComponent(new URL(pathOrUrl).pathname);
    else if (pathOrUrl.startsWith("~/")) filePath = resolve(homedir(), pathOrUrl.slice(2));
    else filePath = resolve(pathOrUrl);
    const info = statSync(filePath);
    if (!info.isFile() || info.size > MAX_IMAGE_BYTES) return null;
    return readFileSync(filePath).toString("base64");
  } catch {
    return null;
  }
}

function imageFromPart(part: Record<string, unknown>): ImageBlock | null {
  const mediaType = (part.mimeType as string | undefined) ?? (part.mediaType as string | undefined);

  const fromString = (raw: string, fallbackType: string): ImageBlock | null => {
    if (raw.length > MAX_BASE64_CHARS + 128) return null;
    const dataUrl = raw.match(/^data:([^;]+);base64,([A-Za-z0-9+/]*={0,2})$/);
    if (dataUrl) {
      if (!IMAGE_MEDIA_TYPES.has(dataUrl[1]) || dataUrl[2].length > MAX_BASE64_CHARS) return null;
      return { type: "image", source: { type: "base64", media_type: dataUrl[1], data: dataUrl[2] } };
    }
    if (raw.startsWith("file://") || raw.startsWith("/") || raw.startsWith("~/")) {
      const data = readLocalBase64(raw);
      if (data == null) return null;
      const pathForInfer = raw.startsWith("file://") ? decodeURIComponent(new URL(raw).pathname) : raw;
      return { type: "image", source: { type: "base64", media_type: mediaType ?? inferMediaType(pathForInfer), data } };
    }
    if (!IMAGE_MEDIA_TYPES.has(fallbackType) || raw.length > MAX_BASE64_CHARS) return null;
    return { type: "image", source: { type: "base64", media_type: fallbackType, data: raw } };
  };

  if (part.type === "image") {
    const image = part.image as unknown;
    if (image instanceof Uint8Array) {
      if (image.byteLength > MAX_IMAGE_BYTES) return null;
      return {
        type: "image",
        source: { type: "base64", media_type: mediaType ?? "image/jpeg", data: Buffer.from(image).toString("base64") },
      };
    }
    if (image instanceof URL) {
      if (image.protocol !== "file:") return null;
      const data = readLocalBase64(image.toString());
      if (data == null) return null;
      return { type: "image", source: { type: "base64", media_type: mediaType ?? inferMediaType(decodeURIComponent(image.pathname)), data } };
    }
    if (typeof image === "string") return fromString(image, "image/jpeg");
    return null;
  }

  if (part.type === "file" && typeof mediaType === "string" && mediaType.startsWith("image/")) {
    const data = part.data as unknown;
    if (data instanceof Uint8Array) {
      if (data.byteLength > MAX_IMAGE_BYTES) return null;
      return { type: "image", source: { type: "base64", media_type: mediaType, data: Buffer.from(data).toString("base64") } };
    }
    if (typeof data === "string") return fromString(data, mediaType);
    if (data instanceof URL) {
      const urlStr = data.toString();
      if (urlStr.length > MAX_BASE64_CHARS + 128) return null;
      const dataUrl = urlStr.match(/^data:([^;]+);base64,([A-Za-z0-9+/]*={0,2})$/);
      if (dataUrl && IMAGE_MEDIA_TYPES.has(dataUrl[1]) && dataUrl[2].length <= MAX_BASE64_CHARS) {
        return { type: "image", source: { type: "base64", media_type: dataUrl[1], data: dataUrl[2] } };
      }
      if (data.protocol !== "file:") return null;
      const b64 = readLocalBase64(urlStr);
      if (b64 == null) return null;
      return { type: "image", source: { type: "base64", media_type: mediaType, data: b64 } };
    }
  }

  return null;
}

function lastUserIndex(prompt: PromptMessage[]): number {
  for (let i = prompt.length - 1; i >= 0; i--) {
    if (prompt[i].role === "user") return i;
  }
  return -1;
}

/** Return only the newest turn when the SDK is resuming an existing session. */
export function latestPrompt(prompt: PromptMessage[]): PromptMessage[] {
  const idx = lastUserIndex(prompt);
  return idx >= 0 ? prompt.slice(idx) : prompt.slice(-1);
}

function trimToBudget(prompt: PromptMessage[], contextWindow: number): PromptMessage[] {
  const budget = Math.floor(contextWindow * BUDGET_RATIO);
  if (prompt.length <= 1) return prompt;

  const working = [...prompt];
  const measure = (msgs: PromptMessage[]) => approxTokens(msgs.map(serializeMessage).join("\n\n"));

  let dropped = 0;
  while (working.length > 1 && measure(working) > budget) {
    const idx = working.findIndex((m) => m.role !== "system");
    if (idx === -1) break;
    working.splice(idx, 1);
    dropped++;
  }

  if (dropped > 0) {
    const marker: PromptMessage = { role: "system", content: `<truncated_history count="${dropped}" />` };
    const insertAt = working.findLastIndex((m) => m.role === "system") + 1;
    working.splice(insertAt, 0, marker);
  }
  return working;
}

function serializeRange(prompt: PromptMessage[], start: number, end: number): string[] {
  const out: string[] = [];
  for (let i = start; i < end; i++) {
    const s = serializeMessage(prompt[i]);
    if (s) out.push(s);
  }
  return out;
}

export function promptHasImage(prompt: PromptMessage[]): boolean {
  const idx = lastUserIndex(prompt);
  if (idx === -1) return false;
  const content = prompt[idx].content;
  if (!Array.isArray(content)) return false;
  return content.some((part) => {
    const p = part as { type?: string; mediaType?: string };
    return p.type === "image" || (p.type === "file" && typeof p.mediaType === "string" && p.mediaType.startsWith("image/"));
  });
}

export function buildPromptString(prompt: PromptMessage[], contextWindow: number): string {
  const effective = trimToBudget(prompt, contextWindow);
  const lastUser = lastUserIndex(effective);
  if (lastUser === -1) return "Hello";

  const history = serializeRange(effective, 0, lastUser);
  const current = serializeMessage(effective[lastUser]);
  const trailing = serializeRange(effective, lastUser + 1, effective.length);

  const segments: string[] = [];
  if (history.length > 0) segments.push(`<conversation_history>\n${history.join("\n\n")}\n${TAG_END("conversation_history")}`);
  segments.push(current);
  if (trailing.length > 0) segments.push(`<conversation_continuation>\n${trailing.join("\n\n")}\n${TAG_END("conversation_continuation")}`);

  return segments.filter(Boolean).join("\n\n") || "Hello";
}

export async function* buildPromptIterable(
  prompt: PromptMessage[],
  contextWindow: number,
  sessionId: string,
): AsyncGenerator<SdkUserMessage> {
  const effective = trimToBudget(prompt, contextWindow);
  const lastUser = lastUserIndex(effective);
  if (lastUser === -1) return;

  const blocks: Array<TextBlock | ImageBlock> = [];

  const history = serializeRange(effective, 0, lastUser);
  if (history.length > 0) {
    blocks.push({ type: "text", text: `<conversation_history>\n${history.join("\n\n")}\n${TAG_END("conversation_history")}` });
  }

  const content = effective[lastUser].content;
  if (Array.isArray(content)) {
    for (const part of content) {
      const p = part as Record<string, unknown>;
      if (p.type === "text" && typeof p.text === "string") {
        blocks.push({ type: "text", text: p.text });
      } else {
        const img = imageFromPart(p);
        if (img) blocks.push(img);
      }
    }
  }

  const trailing = serializeRange(effective, lastUser + 1, effective.length);
  if (trailing.length > 0) {
    blocks.push({ type: "text", text: `<conversation_continuation>\n${trailing.join("\n\n")}\n${TAG_END("conversation_continuation")}` });
  }

  if (blocks.length > 0) {
    yield {
      type: "user",
      session_id: sessionId,
      parent_tool_use_id: null,
      message: { role: "user", content: blocks },
    };
  }
}
