import { describe, expect, it } from "vitest";
import {
  MEMBER_LOOKUP_FAILURE,
  looksLikeEmail,
  memberDisplayName,
  memberInitials,
  type MemberIdentity,
} from "./memberDirectory";

/**
 * Workspace settings used to ask an owner to type a collaborator's internal
 * database id to grant access. These cover the replacement's two obligations:
 * a person is named by email, and the lookup does not become a way to ask "does
 * an account exist for this address?".
 */

describe("looksLikeEmail", () => {
  it.each([
    "name@example.com",
    "first.last+tag@sub.example.co.uk",
    "a@b.co",
  ])("accepts %s", (value) => {
    expect(looksLikeEmail(value)).toBe(true);
  });

  it.each([
    ["", "empty"],
    ["   ", "blank"],
    ["nobody", "no @"],
    ["@example.com", "no local part"],
    ["a@b", "no dot in domain"],
    ["a@.com", "domain starts with dot"],
    ["a@b.", "domain ends with dot"],
    ["two@at@example.com", "two @"],
    ["has space@example.com", "whitespace"],
  ])("rejects %s (%s)", (value) => {
    expect(looksLikeEmail(value)).toBe(false);
  });

  it("rejects an absurdly long address rather than querying with it", () => {
    expect(looksLikeEmail(`${"a".repeat(320)}@example.com`)).toBe(false);
  });
});

describe("lookup failure is a single indistinguishable message", () => {
  it("does not reveal whether the account exists", () => {
    // The same string must cover "no such user", "user outside this
    // organization", and "provider cannot resolve emails". If these ever
    // diverge, an owner-authenticated form becomes an existence oracle for
    // arbitrary addresses.
    expect(MEMBER_LOOKUP_FAILURE).not.toMatch(/exist|unknown account|not found/i);
    expect(MEMBER_LOOKUP_FAILURE).toContain("organization");
  });
});

describe("member display", () => {
  const withName: MemberIdentity = {
    userId: "u1",
    email: "faisal@example.com",
    name: "Faisal Arifi",
  };
  const emailOnly: MemberIdentity = { userId: "u2", email: "zoe@example.com", name: null };

  it("prefers the display name", () => {
    expect(memberDisplayName(withName, "u1")).toBe("Faisal Arifi");
  });

  it("falls back to the email", () => {
    expect(memberDisplayName(emailOnly, "u2")).toBe("zoe@example.com");
  });

  it("never shows a full raw id as the primary label", () => {
    const id = "cmg7x2k9b0001abcdefghijkl";
    const label = memberDisplayName(undefined, id);
    // A membership can outlive the user row it points at; the row must still
    // say something, but not the whole internal identifier.
    expect(label).not.toContain(id);
    expect(label).toContain(id.slice(0, 8));
  });

  it("produces initials from a name, an email, or an id", () => {
    expect(memberInitials(withName, "u1")).toBe("FA");
    expect(memberInitials(emailOnly, "u2")).toBe("ZO");
    expect(memberInitials(undefined, "cm12345")).toBe("CM");
  });
});
