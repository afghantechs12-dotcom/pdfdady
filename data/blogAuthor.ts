import type { BlogAuthor } from "./blog";

/**
 * The site's default author/publisher. Kept in its own module so both blog.ts
 * (which re-exports it) and the generated blogPosts.ts can import the value
 * without creating a circular runtime dependency.
 */
export const AUTHOR_PDFDADI_TEAM: BlogAuthor = {
  name: "PDFDadi Team",
  url: "/about",
  bio: "The PDFDadi Team builds fast, private, browser-based PDF tools. We write practical guides to help you get everyday document work done without installing software or uploading sensitive files.",
};
