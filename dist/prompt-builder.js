import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const CHARS_PER_TOKEN = 4;
const BUDGET_RATIO = 0.7;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_PROMPT_IMAGES = 64;
const MAX_PROMPT_IMAGE_BYTES = 40 * 1024 * 1024;
const MAX_BASE64_CHARS = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4;
const IMAGE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/;
const CONTROL_TAG = /<\/?(?:system|assistant|conversation_history|conversation_continuation|tool_call|tool_result)\b[^>]*>/gi;
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
const TAG_END = (name) => "<" + "/" + name + ">";
function escapeControlTags(text) {
    return text.replace(CONTROL_TAG, (tag) => tag.replace("<", "&lt;").replace(">", "&gt;"));
}
function approxTokens(text) {
    return Math.ceil(text.length / CHARS_PER_TOKEN);
}
function extractText(content) {
    if (typeof content === "string")
        return content;
    if (!Array.isArray(content))
        return "";
    const out = [];
    for (const part of content) {
        if (!isRecord(part))
            continue;
        const p = part;
        if (p.type === "text" && p.text)
            out.push(p.text);
    }
    return out.join("\n");
}
function extractUserText(content) {
    if (typeof content === "string")
        return content;
    if (!Array.isArray(content))
        return "";
    const parts = [];
    for (const part of content) {
        if (!isRecord(part))
            continue;
        const p = part;
        if (p.type === "text" && p.text)
            parts.push(p.text);
        else if (p.type === "image")
            parts.push(`[Image attached: ${p.mimeType ?? "image"}]`);
        else if (p.type === "file") {
            const isImg = typeof p.mediaType === "string" && p.mediaType.toLowerCase().startsWith("image/");
            if (isImg) {
                parts.push(`[Image attached: ${p.mediaType}]`);
            }
            else {
                const fileDesc = p.filename ? `[File attached: ${p.filename}]` : "[File attached]";
                const fileData = typeof p.data === "string" ? p.data : "";
                parts.push(fileData ? `${fileDesc}\n${fileData}` : fileDesc);
            }
        }
    }
    return parts.join("\n");
}
function serializeToolOutput(output) {
    if (output == null)
        return "";
    if (typeof output === "string")
        return escapeControlTags(output);
    if (!Array.isArray(output))
        return escapeControlTags(safeStringify(output, ""));
    const parts = [];
    for (const item of output) {
        if (item && typeof item === "object" && "type" in item) {
            const it = item;
            if (it.type === "text")
                parts.push(String(it.value ?? ""));
            else if (it.type === "json")
                parts.push(safeStringify(it.value, ""));
            else if (it.type === "error-text")
                parts.push(`[Error] ${String(it.value ?? "")}`);
            else
                parts.push(safeStringify(item, ""));
            continue;
        }
        parts.push(safeStringify(item, ""));
    }
    return escapeControlTags(parts.join("\n"));
}
function safeStringify(value, fallback) {
    try {
        return JSON.stringify(value, null, 2) ?? fallback;
    }
    catch {
        return fallback;
    }
}
function escapeAttribute(value) {
    return value.replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
function serializeMessage(msg) {
    switch (msg.role) {
        case "system": {
            const text = extractText(msg.content);
            return text ? `<system>\n${escapeControlTags(text)}\n${TAG_END("system")}` : "";
        }
        case "user":
            return escapeControlTags(extractUserText(msg.content));
        case "assistant": {
            if (!Array.isArray(msg.content))
                return "";
            const parts = [];
            for (const part of msg.content) {
                if (!isRecord(part))
                    continue;
                const p = part;
                if (p.type === "text" && p.text)
                    parts.push(escapeControlTags(p.text));
                else if (p.type === "tool-call") {
                    const input = typeof p.input === "string" ? p.input : safeStringify(p.input ?? {}, "{}");
                    const idAttr = p.toolCallId ? ` id="${escapeAttribute(p.toolCallId)}"` : "";
                    const nameAttr = p.toolName ? ` name="${escapeAttribute(p.toolName)}"` : "";
                    parts.push(`<tool_call${idAttr}${nameAttr}>\n${escapeControlTags(input)}\n${TAG_END("tool_call")}`);
                }
            }
            return parts.length > 0 ? `<assistant>\n${parts.join("\n")}\n${TAG_END("assistant")}` : "";
        }
        case "tool": {
            if (!Array.isArray(msg.content))
                return "";
            const parts = [];
            for (const part of msg.content) {
                if (!isRecord(part))
                    continue;
                const p = part;
                if (p.type === "tool-result") {
                    const idAttr = p.toolCallId ? ` id="${escapeAttribute(p.toolCallId)}"` : "";
                    const nameAttr = p.toolName ? ` name="${escapeAttribute(p.toolName)}"` : "";
                    parts.push(`<tool_result${idAttr}${nameAttr}>\n${serializeToolOutput(p.output)}\n${TAG_END("tool_result")}`);
                }
            }
            return parts.join("\n");
        }
        default:
            return "";
    }
}
function inferMediaType(filePath) {
    const map = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".gif": "image/gif",
    };
    return map[extname(filePath).toLowerCase()] ?? "image/jpeg";
}
function readLocalBase64(pathOrUrl) {
    try {
        let filePath;
        if (pathOrUrl.startsWith("file://"))
            filePath = fileURLToPath(new URL(pathOrUrl));
        else if (pathOrUrl.startsWith("~/"))
            filePath = resolve(homedir(), pathOrUrl.slice(2));
        else
            filePath = resolve(pathOrUrl);
        const info = statSync(filePath);
        if (!info.isFile() || info.size > MAX_IMAGE_BYTES)
            return null;
        return readFileSync(filePath).toString("base64");
    }
    catch {
        return null;
    }
}
function isValidBase64(data) {
    if (data.length === 0 || data.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data))
        return false;
    const unpadded = data.replace(/=+$/, "");
    const decoded = Buffer.from(data, "base64");
    if (decoded.length === 0 || decoded.length > MAX_IMAGE_BYTES)
        return false;
    return decoded.toString("base64").replace(/=+$/, "") === unpadded;
}
function parseDataUrl(raw) {
    if (!raw.startsWith("data:"))
        return null;
    const commaIdx = raw.indexOf(",");
    if (commaIdx <= 5 || commaIdx >= 100)
        return null;
    const meta = raw.slice(5, commaIdx);
    if (!meta.toLowerCase().endsWith(";base64"))
        return null;
    const mime = meta.slice(0, -7).trim().toLowerCase();
    if (!IMAGE_MEDIA_TYPES.has(mime))
        return null;
    const data = raw.slice(commaIdx + 1);
    if (data.length > MAX_BASE64_CHARS || !isValidBase64(data))
        return null;
    return { type: "image", source: { type: "base64", media_type: mime, data } };
}
function imageFromPart(part) {
    const rawMediaType = part.mimeType ?? part.mediaType;
    const mediaType = typeof rawMediaType === "string" ? rawMediaType.toLowerCase() : undefined;
    const fromString = (raw, fallbackType) => {
        if (raw.length > MAX_BASE64_CHARS + 128)
            return null;
        const dataUrl = parseDataUrl(raw);
        if (dataUrl)
            return dataUrl;
        if (raw.startsWith("file://") || raw.startsWith("~/") || isAbsolute(raw) || WINDOWS_ABSOLUTE_PATH.test(raw)) {
            const data = readLocalBase64(raw);
            if (data == null)
                return null;
            const pathForInfer = raw.startsWith("file://") ? fileURLToPath(new URL(raw)) : raw;
            return { type: "image", source: { type: "base64", media_type: mediaType ?? inferMediaType(pathForInfer), data } };
        }
        if (!IMAGE_MEDIA_TYPES.has(fallbackType) || raw.length > MAX_BASE64_CHARS || !isValidBase64(raw))
            return null;
        return { type: "image", source: { type: "base64", media_type: fallbackType, data: raw } };
    };
    if (part.type === "image") {
        const image = part.image;
        if (image instanceof Uint8Array) {
            if (image.byteLength > MAX_IMAGE_BYTES)
                return null;
            return {
                type: "image",
                source: { type: "base64", media_type: mediaType ?? "image/jpeg", data: Buffer.from(image).toString("base64") },
            };
        }
        if (image instanceof URL) {
            if (image.protocol !== "file:")
                return null;
            const data = readLocalBase64(image.toString());
            if (data == null)
                return null;
            return { type: "image", source: { type: "base64", media_type: mediaType ?? inferMediaType(fileURLToPath(image)), data } };
        }
        if (typeof image === "string")
            return fromString(image, "image/jpeg");
        return null;
    }
    if (part.type === "file" && typeof mediaType === "string" && mediaType.startsWith("image/")) {
        const data = part.data;
        if (data instanceof Uint8Array) {
            if (data.byteLength > MAX_IMAGE_BYTES)
                return null;
            return { type: "image", source: { type: "base64", media_type: mediaType, data: Buffer.from(data).toString("base64") } };
        }
        if (typeof data === "string")
            return fromString(data, mediaType);
        if (data instanceof URL) {
            const urlStr = data.toString();
            if (urlStr.length > MAX_BASE64_CHARS + 128)
                return null;
            const dataUrl = parseDataUrl(urlStr);
            if (dataUrl)
                return dataUrl;
            if (data.protocol !== "file:")
                return null;
            const b64 = readLocalBase64(urlStr);
            if (b64 == null)
                return null;
            return { type: "image", source: { type: "base64", media_type: mediaType, data: b64 } };
        }
    }
    return null;
}
function lastUserIndex(prompt) {
    for (let i = prompt.length - 1; i >= 0; i--) {
        if (prompt[i].role === "user")
            return i;
    }
    return -1;
}
function toolCallIds(message) {
    const ids = new Set();
    if (!Array.isArray(message.content))
        return ids;
    for (const part of message.content) {
        if (!isRecord(part))
            continue;
        if (part.type === "tool-call" && typeof part.toolCallId === "string" && part.toolCallId)
            ids.add(part.toolCallId);
        if (part.type === "tool-result" && typeof part.toolCallId === "string" && part.toolCallId)
            ids.add(part.toolCallId);
    }
    return ids;
}
function buildPairedToolGroups(prompt) {
    const owners = new Map();
    const groups = new Map();
    for (let i = 0; i < prompt.length; i++) {
        if (prompt[i].role === "assistant") {
            const group = [i];
            groups.set(i, group);
            for (const id of toolCallIds(prompt[i]))
                owners.set(id, i);
            continue;
        }
        if (prompt[i].role === "tool") {
            const owner = [...toolCallIds(prompt[i])].map((id) => owners.get(id)).find((value) => value !== undefined);
            if (owner === undefined)
                continue;
            const group = groups.get(owner);
            if (group)
                group.push(i);
        }
    }
    for (const group of [...groups.values()]) {
        for (const index of group)
            groups.set(index, group);
    }
    return groups;
}
/** Return only the newest turn when the SDK is resuming an existing session. */
export function latestPrompt(prompt) {
    const idx = lastUserIndex(prompt);
    return idx >= 0 ? prompt.slice(idx) : prompt.slice(-1);
}
function truncateMessage(msg, maxChars) {
    const clip = (value) => value.slice(0, Math.max(0, maxChars));
    if (typeof msg.content === "string")
        return { ...msg, content: clip(msg.content) };
    if (!Array.isArray(msg.content))
        return msg;
    let remaining = Math.max(0, maxChars);
    const content = msg.content.map((part) => {
        if (!isRecord(part))
            return part;
        const copy = { ...part };
        const clipField = (field) => {
            const value = copy[field];
            if (typeof value !== "string")
                return;
            copy[field] = value.slice(0, remaining);
            remaining = Math.max(0, remaining - value.length);
        };
        if (copy.type === "text")
            clipField("text");
        else if (copy.type === "file" && !(typeof copy.mediaType === "string" && copy.mediaType.toLowerCase().startsWith("image/")))
            clipField("data");
        else if (copy.type === "tool-call")
            clipField("input");
        else if (copy.type === "tool-result" && typeof copy.output === "string")
            clipField("output");
        return copy;
    });
    return { ...msg, content };
}
function trimToBudget(prompt, contextWindow) {
    const budget = Math.max(1, Math.floor(contextWindow * BUDGET_RATIO));
    if (prompt.length === 0)
        return prompt;
    const lastUserIdx = lastUserIndex(prompt);
    const serialized = prompt.map((msg) => {
        const text = serializeMessage(msg);
        return { msg, text, tokens: approxTokens(text), dropped: false };
    });
    let remaining = serialized.length;
    let total = 0;
    let dropped = 0;
    for (const item of serialized)
        total += item.tokens;
    const pairedGroups = buildPairedToolGroups(prompt);
    for (let i = 0; i < serialized.length; i++) {
        if (remaining <= 1 || total <= budget)
            break;
        const item = serialized[i];
        if (item.dropped)
            continue;
        if (item.msg.role === "system")
            continue;
        if (i === lastUserIdx)
            continue;
        const group = pairedGroups.get(i) ?? [i];
        if (group.some((value) => value === lastUserIdx || prompt[value].role === "system"))
            continue;
        const activeGroup = group.filter((value) => !serialized[value].dropped);
        if (remaining - activeGroup.length < 1)
            continue;
        for (const value of activeGroup)
            serialized[value].dropped = true;
        total -= activeGroup.reduce((sum, value) => sum + serialized[value].tokens, 0);
        remaining -= activeGroup.length;
        dropped += activeGroup.length;
    }
    const kept = serialized.filter((item) => !item.dropped);
    if (dropped > 0) {
        const markerText = `<truncated_history count="${dropped}" />`;
        const marker = { role: "system", content: markerText };
        const insertAt = kept.findLastIndex((m) => m.msg.role === "system") + 1;
        kept.splice(insertAt, 0, { msg: marker, text: markerText, tokens: approxTokens(markerText), dropped: false });
    }
    // Dropping history normally fits the prompt, but a single current message
    // (or a very large system message) can exceed the remaining context by
    // itself. Clip the largest protected messages as a final safety valve so a
    // malformed/oversized request does not get sent unbounded to the SDK.
    const result = kept.map((item) => item.msg);
    let totalTokens = result.reduce((sum, msg) => sum + approxTokens(serializeMessage(msg)), 0);
    const lastKeptUser = lastUserIndex(result);
    const candidates = [
        ...(lastKeptUser >= 0 ? [lastKeptUser] : []),
        ...result.map((msg, index) => ({ msg, index })).filter(({ msg, index }) => index !== lastKeptUser && msg.role !== "user").map(({ index }) => index),
    ];
    for (const index of candidates) {
        if (totalTokens <= budget)
            break;
        const before = serializeMessage(result[index]);
        const beforeTokens = approxTokens(before);
        const otherTokens = totalTokens - beforeTokens;
        const availableChars = Math.max(0, (budget - otherTokens - 1) * CHARS_PER_TOKEN);
        const clipped = truncateMessage(result[index], availableChars);
        const after = serializeMessage(clipped);
        if (after.length < before.length) {
            result[index] = clipped;
            totalTokens = otherTokens + approxTokens(after);
        }
    }
    return result;
}
function serializeRange(prompt, start, end) {
    const out = [];
    for (let i = start; i < end; i++) {
        const s = serializeMessage(prompt[i]);
        if (s)
            out.push(s);
    }
    return out;
}
export function promptHasImage(prompt) {
    const idx = lastUserIndex(prompt);
    if (idx === -1)
        return false;
    const content = prompt[idx].content;
    if (!Array.isArray(content))
        return false;
    return content.some((part) => {
        if (!isRecord(part))
            return false;
        const p = part;
        return p.type === "image" || (p.type === "file" && typeof p.mediaType === "string" && p.mediaType.toLowerCase().startsWith("image/"));
    });
}
export function buildPromptString(prompt, contextWindow) {
    const effective = trimToBudget(prompt, contextWindow);
    const lastUser = lastUserIndex(effective);
    if (lastUser === -1)
        return "Hello";
    const history = serializeRange(effective, 0, lastUser);
    const current = serializeMessage(effective[lastUser]);
    const trailing = serializeRange(effective, lastUser + 1, effective.length);
    const segments = [];
    if (history.length > 0)
        segments.push(`<conversation_history>\n${history.join("\n\n")}\n${TAG_END("conversation_history")}`);
    segments.push(current);
    if (trailing.length > 0)
        segments.push(`<conversation_continuation>\n${trailing.join("\n\n")}\n${TAG_END("conversation_continuation")}`);
    return segments.filter(Boolean).join("\n\n") || "Hello";
}
export async function* buildPromptIterable(prompt, contextWindow, sessionId) {
    const effective = trimToBudget(prompt, contextWindow);
    const lastUser = lastUserIndex(effective);
    if (lastUser === -1)
        return;
    const blocks = [];
    const history = serializeRange(effective, 0, lastUser);
    if (history.length > 0) {
        blocks.push({ type: "text", text: `<conversation_history>\n${history.join("\n\n")}\n${TAG_END("conversation_history")}` });
    }
    const content = effective[lastUser].content;
    const currentStart = blocks.length;
    let imageCount = 0;
    let imageBytes = 0;
    let omittedImages = 0;
    if (Array.isArray(content)) {
        for (const part of content) {
            if (!isRecord(part))
                continue;
            const p = part;
            if (p.type === "text" && typeof p.text === "string") {
                blocks.push({ type: "text", text: escapeControlTags(p.text) });
            }
            else {
                const img = imageFromPart(p);
                if (img) {
                    const bytes = Math.floor(img.source.data.length * 3 / 4);
                    if (imageCount >= MAX_PROMPT_IMAGES || imageBytes + bytes > MAX_PROMPT_IMAGE_BYTES) {
                        omittedImages++;
                    }
                    else {
                        blocks.push(img);
                        imageCount++;
                        imageBytes += bytes;
                    }
                }
            }
        }
    }
    if (omittedImages > 0) {
        blocks.push({ type: "text", text: `[${omittedImages} image attachment(s) omitted because the request image limit was reached]` });
    }
    if (blocks.length === currentStart) {
        blocks.push({ type: "text", text: escapeControlTags(extractUserText(content) || "Hello") });
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
//# sourceMappingURL=prompt-builder.js.map