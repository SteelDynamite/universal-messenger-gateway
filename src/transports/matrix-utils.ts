/**
 * Pure utility functions for Matrix transport.
 * Extracted for testability; no SDK or network dependencies.
 */

import { decodeHTML } from "entities";
import { Marked, Renderer, TextRenderer } from "marked";
import sanitizeHtml from "sanitize-html";
import stringWidth from "string-width";
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

const MATRIX_HTML_TAGS = [
  "del",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "p",
  "a",
  "ul",
  "ol",
  "sup",
  "sub",
  "li",
  "b",
  "i",
  "u",
  "strong",
  "em",
  "s",
  "code",
  "hr",
  "br",
  "div",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "caption",
  "pre",
  "span",
  "img",
  "details",
  "summary",
];

const plainTextRenderer = new TextRenderer();
plainTextRenderer.br = () => " ";
plainTextRenderer.html = ({ text }) =>
  /^<br\s*\/?\s*>$/i.test(text)
    ? " "
    : sanitizeHtml(text, { allowedTags: [], allowedAttributes: {} });

const renderer = new Renderer();
renderer.checkbox = ({ checked }) => (checked ? "[x] " : "[ ] ");
renderer.table = function ({ header, rows }) {
  const parsedRows = [header, ...rows].map((row) =>
    row.map((cell) =>
      decodeHTML(this.parser.parseInline(cell.tokens, plainTextRenderer))
        .replace(/\s+/gu, " ")
        .trim(),
    ),
  );
  const widths = header.map((_, column) =>
    Math.max(3, ...parsedRows.map((row) => stringWidth(row[column] ?? ""))),
  );
  const alignments = header.map((cell) => cell.align);
  const lines = [
    formatTableRow(parsedRows[0] ?? [], widths, alignments),
    widths.map((width) => "-".repeat(width)).join("-+-"),
    ...parsedRows
      .slice(1)
      .map((row) => formatTableRow(row, widths, alignments)),
  ];
  return `<pre><code>${escapeHtml(lines.join("\n"))}</code></pre>`;
};
renderer.link = function ({ href, tokens }) {
  const label = this.parser.parseInline(tokens);
  const safeHref = safeMatrixHref(href);
  return safeHref
    ? `<a href="${escapeHtml(safeHref)}">${label}</a>`
    : `${label} (${escapeHtml(href)})`;
};
renderer.image = function ({ href, tokens }) {
  const alt = escapeHtml(
    this.parser.parseInline(tokens, new TextRenderer()).trim() || href,
  );
  const safeHref = safeMatrixHref(href);
  return safeHref
    ? `<a href="${escapeHtml(safeHref)}">${alt}</a>`
    : `${alt} (${escapeHtml(href)})`;
};

const markdown = new Marked({ gfm: true, breaks: true, renderer });

function formatTableRow(
  cells: string[],
  widths: number[],
  alignments: Array<"center" | "left" | "right" | null>,
): string {
  return widths
    .map((width, column) => {
      const cell = cells[column] ?? "";
      const padding = width - stringWidth(cell);
      if (alignments[column] === "right")
        return `${" ".repeat(padding)}${cell}`;
      if (alignments[column] === "center") {
        const left = Math.floor(padding / 2);
        return `${" ".repeat(left)}${cell}${" ".repeat(padding - left)}`;
      }
      return `${cell}${" ".repeat(padding)}`;
    })
    .join(" | ");
}

export function formatForMatrix(text: string): MatrixFormattedMessage {
  const html = markdown.parse(text, { async: false });
  const formattedBody = sanitizeHtml(html, {
    allowedTags: MATRIX_HTML_TAGS,
    allowedAttributes: {
      a: ["href", "target"],
      img: ["width", "height", "alt", "title", "src"],
      ol: ["start"],
      code: ["class"],
      span: [
        "data-mx-bg-color",
        "data-mx-color",
        "data-mx-spoiler",
        "data-mx-maths",
      ],
      div: ["data-mx-maths"],
    },
    allowedSchemes: ["https", "http", "ftp", "mailto", "magnet"],
    allowedSchemesByTag: { img: ["mxc"] },
    allowProtocolRelative: false,
    nestingLimit: 100,
    transformTags: {
      a: (tagName, attribs) => {
        const href = safeMatrixHref(attribs.href);
        return {
          tagName,
          attribs: href
            ? {
                href,
                ...(attribs.target ? { target: attribs.target } : {}),
              }
            : {},
        };
      },
      code: (tagName, attribs) => ({
        tagName,
        attribs:
          typeof attribs.class === "string" &&
          /^language-[\w-]+$/.test(attribs.class)
            ? { class: attribs.class }
            : {},
      }),
    },
    exclusiveFilter: ({ tag, attribs }) =>
      tag === "img" && !attribs.src?.startsWith("mxc://"),
  }).trim();

  return { body: text, formattedBody };
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

export function shouldSkipReactionEvent(
  event: Pick<MatrixRoomEvent, "sender" | "origin_server_ts">,
  botUserId: string,
  connectedAt: number,
  joinedRooms: Set<string>,
  roomId: string,
): string | null {
  if (event.sender === botUserId) {
    return "own_reaction";
  }

  const eventTs = event.origin_server_ts ?? 0;
  if (eventTs < connectedAt) {
    return "stale";
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

function safeMatrixHref(href: string | undefined): string | undefined {
  if (!href) return undefined;

  try {
    const url = new URL(href);
    return ["http:", "https:", "ftp:", "mailto:", "magnet:"].includes(
      url.protocol,
    )
      ? href
      : undefined;
  } catch {
    return undefined;
  }
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
