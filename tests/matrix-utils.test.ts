import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  escapeHtml,
  extractUsername,
  formatForMatrix,
  mediaAttachmentFromMatrixContent,
  shouldSkipEvent,
  shouldSkipReactionEvent,
  stripBotMention,
  wasBotMentioned,
} from "../src/transports/matrix-utils.js";

describe("escapeHtml", () => {
  it("escapes ampersand", () => {
    expect(escapeHtml("a & b")).toBe("a &amp; b");
  });

  it("escapes angle brackets", () => {
    expect(escapeHtml("<script>")).toBe("&lt;script&gt;");
  });

  it("escapes double quotes", () => {
    expect(escapeHtml('say "hello"')).toBe("say &quot;hello&quot;");
  });

  it("handles all special chars together", () => {
    expect(escapeHtml('<a href="x">&')).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;",
    );
  });

  it("returns plain text unchanged", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });

  it("handles empty string", () => {
    expect(escapeHtml("")).toBe("");
  });
});

describe("formatForMatrix", () => {
  it("preserves the original body and formats plain text", () => {
    expect(formatForMatrix("hello world")).toEqual({
      body: "hello world",
      formattedBody: "<p>hello world</p>",
    });
  });

  it("renders GFM inline formatting", () => {
    const result = formatForMatrix(
      "**bold**, _italic_, ~~deleted~~, and `code`",
    );
    expect(result.formattedBody).toContain("<strong>bold</strong>");
    expect(result.formattedBody).toContain("<em>italic</em>");
    expect(result.formattedBody).toContain("<del>deleted</del>");
    expect(result.formattedBody).toContain("<code>code</code>");
  });

  it("renders headings, blockquotes, and lists", () => {
    const result = formatForMatrix(
      "# Heading\n\n> quote\n\n- one\n- two\n\n3. three",
    );
    expect(result.formattedBody).toContain("<h1>Heading</h1>");
    expect(result.formattedBody).toContain("<blockquote>");
    expect(result.formattedBody).toContain("<ul>");
    expect(result.formattedBody).toContain('<ol start="3">');
  });

  it("renders task lists without unsupported input elements", () => {
    const result = formatForMatrix("- [x] done\n- [ ] todo");
    expect(result.formattedBody).toContain("<li>[x] done</li>");
    expect(result.formattedBody).toContain("<li>[ ] todo</li>");
    expect(result.formattedBody).not.toContain("<input");
  });

  it("renders GFM tables with Matrix-supported attributes", () => {
    const result = formatForMatrix(
      "| left | right |\n| :--- | ---: |\n| one | two |",
    );
    expect(result.formattedBody).toContain("<table>");
    expect(result.formattedBody).toContain("<th>left</th>");
    expect(result.formattedBody).toContain("<td>two</td>");
    expect(result.formattedBody).not.toContain("align=");
  });

  it("renders links and GFM autolinks", () => {
    const result = formatForMatrix(
      "[label](https://example.com/path) and https://matrix.org",
    );
    expect(result.formattedBody).toContain(
      '<a href="https://example.com/path">label</a>',
    );
    expect(result.formattedBody).toContain(
      '<a href="https://matrix.org">https://matrix.org</a>',
    );
  });

  it("rejects unsafe and relative links", () => {
    const unsafe = formatForMatrix(
      "[bad](javascript:alert(1)) and [local](/path)",
    );
    expect(unsafe.formattedBody).not.toContain("href=");
    expect(unsafe.formattedBody).toContain("bad (javascript:alert(1))");
    expect(unsafe.formattedBody).toContain("local (/path)");
  });

  it("renders Markdown images as linked plain alt text", () => {
    const result = formatForMatrix(
      "![alt *text*](https://example.com/image.png)",
    );
    expect(result.formattedBody).toContain(
      '<a href="https://example.com/image.png">alt text</a>',
    );
    expect(result.formattedBody).not.toContain("<img");
  });

  it("preserves line breaks for chat rendering", () => {
    const result = formatForMatrix("line one\nline two");
    expect(result.formattedBody).toMatch(/<br\s*\/>/);
  });

  it("renders fenced code and permits safe language classes", () => {
    const result = formatForMatrix(
      "```typescript\nconst html = '<script>';\n```",
    );
    expect(result.formattedBody).toContain("<pre><code");
    expect(result.formattedBody).toContain('class="language-typescript"');
    expect(result.formattedBody).toContain("&lt;script&gt;");
    expect(result.formattedBody).not.toContain("<script>");
  });

  it("sanitizes raw HTML to the Matrix subset", () => {
    const result = formatForMatrix(
      '<u onclick="alert(1)">safe</u><a href="/relative">local</a><a href="javascript:bad">bad</a><script>alert(2)</script>',
    );
    expect(result.formattedBody).toContain("<u>safe</u>");
    expect(result.formattedBody).toContain("<a>local</a><a>bad</a>");
    expect(result.formattedBody).not.toContain("href=");
    expect(result.formattedBody).not.toContain("onclick");
    expect(result.formattedBody).not.toContain("<script");
  });

  it("allows mxc images from raw Matrix HTML only", () => {
    const result = formatForMatrix(
      '<img src="https://example.com/tracker.png" alt="remote"><img src="mxc://example.org/id" alt="mxc" onerror="bad">',
    );
    expect(result.formattedBody).not.toContain("tracker.png");
    expect(result.formattedBody).toContain(
      '<img src="mxc://example.org/id" alt="mxc" />',
    );
    expect(result.formattedBody).not.toContain("onerror");
  });

  it("escapes HTML inside code", () => {
    const block = formatForMatrix("```\n<script>alert('xss')</script>\n```");
    const inline = formatForMatrix("use `<div>` tag");
    expect(block.formattedBody).toContain("&lt;script&gt;");
    expect(block.formattedBody).not.toContain("<script>");
    expect(inline.formattedBody).toContain("&lt;div&gt;");
  });
});

describe("shouldSkipEvent", () => {
  const botUserId = "@bot:matrix.org";
  const connectedAt = 1000;
  const joinedRooms = new Set(["!room1:matrix.org", "!room2:matrix.org"]);

  function makeEvent(overrides: Record<string, unknown> = {}) {
    return {
      sender: "@user:matrix.org",
      origin_server_ts: 2000,
      content: { msgtype: "m.text", body: "hello" },
      ...overrides,
    };
  }

  it("returns null for a valid message", () => {
    expect(
      shouldSkipEvent(
        makeEvent(),
        botUserId,
        connectedAt,
        joinedRooms,
        "!room1:matrix.org",
      ),
    ).toBeNull();
  });

  it("skips own messages", () => {
    expect(
      shouldSkipEvent(
        makeEvent({ sender: botUserId }),
        botUserId,
        connectedAt,
        joinedRooms,
        "!room1:matrix.org",
      ),
    ).toBe("own_message");
  });

  it("skips stale events", () => {
    expect(
      shouldSkipEvent(
        makeEvent({ origin_server_ts: 500 }),
        botUserId,
        connectedAt,
        joinedRooms,
        "!room1:matrix.org",
      ),
    ).toBe("stale");
  });

  it("does not skip events exactly at connectedAt", () => {
    expect(
      shouldSkipEvent(
        makeEvent({ origin_server_ts: 1000 }),
        botUserId,
        connectedAt,
        joinedRooms,
        "!room1:matrix.org",
      ),
    ).toBeNull();
  });

  it("accepts supported media messages", () => {
    expect(
      shouldSkipEvent(
        makeEvent({
          content: {
            msgtype: "m.image",
            body: "photo.png",
            url: "mxc://example/photo",
          },
        }),
        botUserId,
        connectedAt,
        joinedRooms,
        "!room1:matrix.org",
      ),
    ).toBeNull();
  });

  it("skips unsupported messages", () => {
    expect(
      shouldSkipEvent(
        makeEvent({ content: { msgtype: "m.location", body: "geo" } }),
        botUserId,
        connectedAt,
        joinedRooms,
        "!room1:matrix.org",
      ),
    ).toBe("unsupported_message");
  });

  it("skips edits", () => {
    expect(
      shouldSkipEvent(
        makeEvent({
          content: {
            msgtype: "m.text",
            body: "edited",
            "m.new_content": { body: "new" },
          },
        }),
        botUserId,
        connectedAt,
        joinedRooms,
        "!room1:matrix.org",
      ),
    ).toBe("edit");
  });

  it("skips events from rooms not in joinedRooms", () => {
    expect(
      shouldSkipEvent(
        makeEvent(),
        botUserId,
        connectedAt,
        joinedRooms,
        "!unknown:matrix.org",
      ),
    ).toBe("not_joined");
  });
});

describe("shouldSkipReactionEvent", () => {
  const botUserId = "@bot:matrix.org";
  const connectedAt = 1000;
  const joinedRooms = new Set(["!room1:matrix.org"]);

  it("skips own reactions", () => {
    expect(
      shouldSkipReactionEvent(
        { sender: botUserId, origin_server_ts: 2000 },
        botUserId,
        connectedAt,
        joinedRooms,
        "!room1:matrix.org",
      ),
    ).toBe("own_reaction");
  });

  it("skips stale reactions", () => {
    expect(
      shouldSkipReactionEvent(
        { sender: "@user:matrix.org", origin_server_ts: 999 },
        botUserId,
        connectedAt,
        joinedRooms,
        "!room1:matrix.org",
      ),
    ).toBe("stale");
  });

  it("skips reactions for rooms not joined after connect", () => {
    expect(
      shouldSkipReactionEvent(
        { sender: "@user:matrix.org", origin_server_ts: 2000 },
        botUserId,
        connectedAt,
        joinedRooms,
        "!unknown:matrix.org",
      ),
    ).toBe("not_joined");
  });

  it("accepts current reactions from joined rooms", () => {
    expect(
      shouldSkipReactionEvent(
        { sender: "@user:matrix.org", origin_server_ts: 2000 },
        botUserId,
        connectedAt,
        joinedRooms,
        "!room1:matrix.org",
      ),
    ).toBeNull();
  });
});

describe("mediaAttachmentFromMatrixContent", () => {
  it("extracts Matrix media metadata", () => {
    expect(
      mediaAttachmentFromMatrixContent({
        msgtype: "m.image",
        body: "photo.png",
        url: "mxc://example/photo",
        info: { mimetype: "image/png", size: 1234 },
      }),
    ).toEqual({
      mediaId: "mxc://example/photo",
      kind: "image",
      fileName: "photo.png",
      description: "photo.png",
      mimeType: "image/png",
      sizeBytes: 1234,
    });
  });

  it("extracts encrypted-file media URLs", () => {
    expect(
      mediaAttachmentFromMatrixContent({
        msgtype: "m.file",
        body: "doc.pdf",
        file: { url: "mxc://example/encrypted" },
      }),
    ).toMatchObject({
      mediaId: "mxc://example/encrypted",
      kind: "file",
      fileName: "doc.pdf",
    });
  });

  it("ignores non-media content", () => {
    expect(
      mediaAttachmentFromMatrixContent({ msgtype: "m.text", body: "hello" }),
    ).toBeUndefined();
  });
});

describe("extractUsername", () => {
  it("extracts localpart from full MXID", () => {
    expect(extractUsername("@alice:matrix.org")).toBe("alice");
  });

  it("handles homeserver with port", () => {
    expect(extractUsername("@bob:localhost:8448")).toBe("bob");
  });

  it("handles already plain username", () => {
    expect(extractUsername("charlie")).toBe("charlie");
  });

  it("handles MXID without @ prefix", () => {
    expect(extractUsername("dave:matrix.org")).toBe("dave");
  });
});

describe("wasBotMentioned", () => {
  const botUserId = "@pibot:matrix.org";

  it("detects full MXID mention", () => {
    expect(wasBotMentioned("hey @pibot:matrix.org do this", botUserId)).toBe(
      true,
    );
  });

  it("detects @localpart mention case-insensitively", () => {
    expect(wasBotMentioned("hey @Pibot do this", botUserId)).toBe(true);
  });

  it("returns false when not mentioned", () => {
    expect(wasBotMentioned("hello world", botUserId)).toBe(false);
  });

  it("returns false for bare localpart without @", () => {
    expect(wasBotMentioned("pibot help", botUserId)).toBe(false);
  });
});

describe("stripBotMention", () => {
  const botUserId = "@pibot:matrix.org";

  it("strips full MXID mention", () => {
    expect(stripBotMention("@pibot:matrix.org help me", botUserId)).toBe(
      "help me",
    );
  });

  it("strips multiple mentions", () => {
    expect(
      stripBotMention("@pibot:matrix.org hey @pibot:matrix.org", botUserId),
    ).toBe("hey");
  });

  it("returns original text when no mention present", () => {
    expect(stripBotMention("hello world", botUserId)).toBe("hello world");
  });

  it("handles message that is only the mention", () => {
    expect(stripBotMention("@pibot:matrix.org", botUserId)).toBe("");
  });
});

describe("formatForMatrix properties", () => {
  it("body always equals original input", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const result = formatForMatrix(text);
        expect(result.body).toBe(text);
      }),
    );
  });

  it("formattedBody never emits executable HTML", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const formatted = formatForMatrix(text).formattedBody ?? "";
        expect(formatted).not.toMatch(/<(script|iframe|style)\b/i);
        expect(formatted).not.toMatch(/\son\w+=/i);
      }),
    );
  });
});

describe("stripBotMention properties", () => {
  it("result never contains the bot MXID", () => {
    const localpart = fc
      .string({ minLength: 1, maxLength: 10 })
      .filter((s) => !/[@: ]/.test(s));
    const server = fc
      .string({ minLength: 1, maxLength: 10 })
      .filter((s) => !/[@: ]/.test(s));
    const mxid = fc
      .tuple(localpart, server)
      .map(([user, host]) => `@${user}:${host}`);

    fc.assert(
      fc.property(mxid, fc.string(), (botId, prefix) => {
        const text = `${prefix} ${botId} some text`;
        const result = stripBotMention(text, botId);
        expect(result).not.toContain(botId);
      }),
    );
  });
});

describe("escapeHtml properties", () => {
  it("output never contains raw special characters outside entities", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const result = escapeHtml(text);
        const withoutEntities = result
          .replace(/&amp;/g, "")
          .replace(/&lt;/g, "")
          .replace(/&gt;/g, "")
          .replace(/&quot;/g, "");
        expect(withoutEntities).not.toMatch(/[<>"&]/);
      }),
    );
  });
});
