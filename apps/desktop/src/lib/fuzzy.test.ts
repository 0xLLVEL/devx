import { describe, expect, it } from "vitest";

import { rankItems, scoreMatch } from "@/lib/fuzzy";

/**
 * §57 fixes the ranking: exact name, then prefix, then fuzzy, then type/path/
 * tags. These cases exist so a future "improvement" to the matcher cannot
 * quietly reorder the palette.
 */
describe("scoreMatch", () => {
  it("returns null when the query is not in the text at all", () => {
    expect(scoreMatch("zzz", "Terminal")).toBeNull();
  });

  it("scores an exact name above everything else", () => {
    expect(scoreMatch("terminal", "Terminal")).toBeGreaterThan(0);
    expect(scoreMatch("terminal", "Terminal")).toBe(
      Math.max(
        scoreMatch("terminal", "Terminal") ?? 0,
        scoreMatch("term", "Terminal") ?? 0,
        scoreMatch("term", "Terminal settings") ?? 0,
      ),
    );
  });

  it("scores a prefix above a mid-word match", () => {
    expect(scoreMatch("term", "Terminal")).toBeGreaterThan(
      scoreMatch("term", "My terminal") ?? 0,
    );
  });

  it("matches in-order characters that are not adjacent", () => {
    expect(scoreMatch("tmnl", "Terminal")).not.toBeNull();
  });

  it("treats an empty query as a match for everything", () => {
    expect(scoreMatch("", "Anything")).toBe(0);
  });

  it("is case-insensitive", () => {
    expect(scoreMatch("TERM", "terminal")).not.toBeNull();
  });
});

describe("rankItems", () => {
  const items = [
    { id: "logs", title: "Logs", keywords: ["output", "error"] },
    { id: "terminal", title: "Terminal", keywords: ["shell"] },
    { id: "settings", title: "Settings", keywords: ["config"] },
  ];
  const keys = (item: (typeof items)[number]) => ({
    name: item.title,
    aliases: item.keywords,
  });

  it("keeps the caller's order for an empty query", () => {
    expect(rankItems("", items, keys).map((entry) => entry.item.id)).toEqual([
      "logs",
      "terminal",
      "settings",
    ]);
  });

  it("ranks the best name match first", () => {
    expect(rankItems("term", items, keys).map((entry) => entry.item.id)).toEqual([
      "terminal",
    ]);
  });

  it("finds items through their keywords", () => {
    expect(rankItems("shell", items, keys).map((entry) => entry.item.id)).toEqual([
      "terminal",
    ]);
  });

  it("prefers a name match over a keyword match", () => {
    const withOverlap = [
      { id: "terminal", title: "Terminal", keywords: [] as string[] },
      { id: "other", title: "Recent activity", keywords: ["terminal"] },
    ];
    expect(
      rankItems("terminal", withOverlap, (item) => ({
        name: item.title,
        aliases: item.keywords,
      })).map((entry) => entry.item.id),
    ).toEqual(["terminal", "other"]);
  });

  it("drops items that do not match", () => {
    expect(rankItems("nonexistent", items, keys)).toEqual([]);
  });
});
