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
  it("returns plain body only for text without markdown", () => {
    const result = formatForMatrix("hello world");
    expect(result).toEqual({ body: "hello world" });
    expect(result.formattedBody).toBeUndefined();
  });

  it("converts **bold** to <strong>", () => {
    const result = formatForMatrix("this is **bold** text");
    expect(result.body).toBe("this is **bold** text");
    expect(result.formattedBody).toContain("<strong>bold</strong>");
  });

  it("converts *italic* to <em>", () => {
    const result = formatForMatrix("this is *italic* text");
    expect(result.formattedBody).toContain("<em>italic</em>");
  });

  it("does not confuse **bold** with *italic*", () => {
    const result = formatForMatrix("**bold** and *italic*");
    expect(result.formattedBody).toContain("<strong>bold</strong>");
    expect(result.formattedBody).toContain("<em>italic</em>");
  });

  it("converts [text](url) to <a href>", () => {
    const result = formatForMatrix("click [here](https://example.com)");
    expect(result.formattedBody).toContain(
      '<a href="https://example.com">here</a>',
    );
  });

  it("escapes link labels and rejects unsafe URL schemes", () => {
    const label = formatForMatrix(
      'click [<b>here</b>](https://example.com?q="x")',
    );
    expect(label.formattedBody).toContain(
      '<a href="https://example.com?q=&quot;x&quot;">&lt;b&gt;here&lt;/b&gt;</a>',
    );

    const unsafe = formatForMatrix("click [here](javascript:alert(1))");
    expect(unsafe.formattedBody).not.toContain("<a ");
  });

  it("converts newlines to <br>", () => {
    const result = formatForMatrix("line *one*\nline two");
    expect(result.formattedBody).toContain("<br>");
  });

  it("protects inline code from markdown conversion", () => {
    const result = formatForMatrix("use `**not bold**` here");
    expect(result.formattedBody).toContain("<code>");
    expect(result.formattedBody).not.toContain("<strong>not bold</strong>");
  });

  it("protects code blocks from markdown conversion", () => {
    const result = formatForMatrix("```\n**not bold**\n```");
    expect(result.formattedBody).toContain("<pre><code>");
    expect(result.formattedBody).not.toContain("<strong>");
  });

  it("adds language class to code blocks", () => {
    const result = formatForMatrix("```typescript\nconst x = 1;\n```");
    expect(result.formattedBody).toContain('class="language-typescript"');
  });

  it("escapes HTML inside code blocks", () => {
    const result = formatForMatrix("```\n<script>alert('xss')</script>\n```");
    expect(result.formattedBody).toContain("&lt;script&gt;");
    expect(result.formattedBody).not.toContain("<script>");
  });

  it("escapes HTML inside inline code", () => {
    const result = formatForMatrix("use `<div>` tag");
    expect(result.formattedBody).toContain("&lt;div&gt;");
  });

  it("escapes HTML outside code", () => {
    const result = formatForMatrix("<img src=x onerror=alert(1)> and **bold**");
    expect(result.formattedBody).toContain(
      "&lt;img src=x onerror=alert(1)&gt;",
    );
    expect(result.formattedBody).not.toContain("<img");
  });

  it("preserves original text as body even when formatted", () => {
    const original = "**bold** and `code`";
    const result = formatForMatrix(original);
    expect(result.body).toBe(original);
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

  it("formattedBody is undefined when no markdown chars present", () => {
    const noMarkdown = fc.string().filter((s) => !/[*_`#[]/.test(s));

    fc.assert(
      fc.property(noMarkdown, (text) => {
        const result = formatForMatrix(text);
        expect(result.formattedBody).toBeUndefined();
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
