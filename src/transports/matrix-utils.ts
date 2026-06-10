/**
 * Pure utility functions for Matrix transport.
 * Extracted for testability; no SDK or network dependencies.
 */

import type { MediaAttachment } from "../protocol.js";

export type MatrixRoomEvent = {
  sender?: string;
  origin_server_ts?: number;
  content?: {
    msgtype?: string;
    body?: string;
    url?: string;
    file?: { url?: string };
    info?: {
      mimetype?: string;
      size?: number;
    };
    "m.new_content"?: unknown;
  };
};

export type MatrixFormattedMessage = {
  body: string;
  formattedBody?: string;
};

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function formatForMatrix(text: string): MatrixFormattedMessage {
  const hasMarkdown = /[*_`#[]/.test(text);

  if (!hasMarkdown) {
    return { body: text };
  }

  let html = text;
  const codeBlocks: string[] = [];
  const inlineCodes: string[] = [];

  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    codeBlocks.push(
      `<pre><code${lang ? ` class="language-${lang}"` : ""}>${escapeHtml(code.trimEnd())}</code></pre>`,
    );
    return `__CODEBLOCK_${codeBlocks.length - 1}__`;
  });

  html = html.replace(/`([^`]+)`/g, (_, code) => {
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
    return `__INLINECODE_${inlineCodes.length - 1}__`;
  });

  html = html.replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(?<!\*)\*(?!\*)([^*]+?)(?<!\*)\*(?!\*)/g, "<em>$1</em>");
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  html = html.replace(/\n/g, "<br>");
  html = html.replace(
    /__CODEBLOCK_(\d+)__/g,
    (_, idx) => codeBlocks[Number.parseInt(idx, 10)] ?? "",
  );
  html = html.replace(
    /__INLINECODE_(\d+)__/g,
    (_, idx) => inlineCodes[Number.parseInt(idx, 10)] ?? "",
  );

  return { body: text, formattedBody: html };
}

export function shouldSkipEvent(
  event: MatrixRoomEvent,
  botUserId: string,
  connectedAt: number,
  joinedRooms: Set<string>,
  roomId: string,
): string | null {
  if (event.sender === botUserId) {
    return "own_message";
  }

  const eventTs = event.origin_server_ts ?? 0;
  if (eventTs < connectedAt) {
    return "stale";
  }

  const content = event.content;
  if (!content || !isSupportedMessageContent(content)) {
    return "unsupported_message";
  }

  if (content["m.new_content"]) {
    return "edit";
  }

  if (!joinedRooms.has(roomId)) {
    return "not_joined";
  }

  return null;
}

export function mediaAttachmentFromMatrixContent(
  content: MatrixRoomEvent["content"],
): MediaAttachment | undefined {
  if (!content?.msgtype) {
    return undefined;
  }

  const kind = mediaKindForMatrixMsgType(content.msgtype);
  if (!kind) {
    return undefined;
  }

  const mediaId = content.url ?? content.file?.url;
  if (!mediaId) {
    return undefined;
  }

  return {
    mediaId,
    kind,
    ...(content.body
      ? { fileName: content.body, description: content.body }
      : {}),
    ...(content.info?.mimetype ? { mimeType: content.info.mimetype } : {}),
    ...(typeof content.info?.size === "number"
      ? { sizeBytes: content.info.size }
      : {}),
  };
}

function isSupportedMessageContent(
  content: NonNullable<MatrixRoomEvent["content"]>,
): boolean {
  if (content.msgtype === "m.text") {
    return !!content.body;
  }
  return !!mediaAttachmentFromMatrixContent(content);
}

function mediaKindForMatrixMsgType(
  msgtype: string,
): MediaAttachment["kind"] | undefined {
  if (msgtype === "m.image") return "image";
  if (msgtype === "m.file") return "file";
  if (msgtype === "m.audio") return "audio";
  if (msgtype === "m.video") return "video";
  return undefined;
}

export function extractUsername(userId: string): string {
  return userId.replace(/^@/, "").replace(/:.*$/, "");
}

export function wasBotMentioned(
  messageText: string,
  botUserId: string,
): boolean {
  if (messageText.includes(botUserId)) {
    return true;
  }

  const localpart = extractUsername(botUserId);
  if (!localpart) {
    return false;
  }

  return new RegExp(`@${escapeRegExp(localpart)}\\b`, "i").test(messageText);
}

export function stripBotMention(text: string, botUserId: string): string {
  const localpart = extractUsername(botUserId);
  let out = text.replace(new RegExp(escapeRegExp(botUserId), "g"), "");

  if (localpart) {
    out = out.replace(new RegExp(`@${escapeRegExp(localpart)}\\b`, "gi"), "");
  }

  return out.trim();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
