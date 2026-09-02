import { describe, expect, it } from "vitest";
import {
  SEARCH_LIMITS,
  normalizeSearchText,
  parseSearchQuery,
  tokenizeQuery,
} from "./SearchIndex";

describe("SearchIndex query parsing", () => {
  it("rejects punctuation-only queries", () => {
    expect(parseSearchQuery("!!! ??")).toBeNull();
  });

  it("rejects one-character queries", () => {
    expect(parseSearchQuery("a")).toBeNull();
  });

  it("accepts and consistently normalizes Unicode words", () => {
    expect(parseSearchQuery("résumé")?.terms).toEqual(["resume"]);
  });

  it("accepts numeric terms", () => {
    expect(parseSearchQuery("2026")?.terms).toEqual(["2026"]);
  });

  it("retains regex-looking syntax as literal text", () => {
    expect(parseSearchQuery(".*contract.*")?.terms).toEqual([".*contract.*"]);
    expect(parseSearchQuery(".*contract.*")?.terms).not.toContain("contract");
  });

  it("deduplicates normalized terms", () => {
    expect(tokenizeQuery("Contract contract CONTRACT")).toEqual(["contract"]);
  });

  it("truncates excessive terms and reports truncation", () => {
    const query = Array.from(
      { length: SEARCH_LIMITS.maxQueryTerms + 2 },
      (_, index) => `term${index}`,
    ).join(" ");
    const parsed = parseSearchQuery(query);

    expect(parsed?.terms).toHaveLength(SEARCH_LIMITS.maxQueryTerms);
    expect(parsed?.truncated).toBe(true);
  });

  it("rejects an overlong query", () => {
    expect(parseSearchQuery("x".repeat(SEARCH_LIMITS.maxQueryLength + 1))).toBeNull();
  });

  it("collapses and trims whitespace", () => {
    expect(parseSearchQuery("  quarterly\n\t contract  ")).toEqual({
      raw: "quarterly contract",
      terms: ["quarterly", "contract"],
      truncated: false,
    });
  });

  it("normalizes compatibility forms and diacritics", () => {
    expect(normalizeSearchText("  Ｒésumé\tCAFÉ  ")).toBe("resume cafe");
  });
});
