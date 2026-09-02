export interface FAQItem {
  id: string;
  question: string;
  answer: string;
}

/**
 * Homepage FAQ.
 *
 * Answers must describe what the product actually does today. The previous set
 * asserted that files are only ever processed locally and never retained —
 * both untrue given 14 server-side tools and durable Workspace storage — and
 * listed compress/OCR as forthcoming when both already ship. The removed
 * phrasings are enumerated in FORBIDDEN_CLAIMS and enforced by a source scan
 * in lib/tools/processingMode.test.ts. See docs/launch-feature-evidence.md.
 */
export const faqItems: FAQItem[] = [
  {
    id: "free",
    question: "Is it free to use?",
    answer:
      "Yes. Every PDF tool available today is free to use, and a Workspace account is free to create. Paid plans are not available yet.",
  },
  {
    id: "secure",
    question: "Where are my files processed?",
    answer:
      "It depends on the tool, and each tool says so before you choose a file. Most editing and page tools run in your browser, so the file is not sent to our servers for that operation. Tools that need more than a browser can do — compression, OCR, Office conversion, password protection — upload your file over an encrypted connection, process it, and remove it from temporary processing storage once you have downloaded the result.",
  },
  {
    id: "storage",
    question: "What happens to files I save to my Workspace?",
    answer:
      "They are stored so you can come back to them: open them in the editor, keep them in folders, and restore earlier versions. They stay available until you delete or archive them. That is deliberate — a Workspace is for documents you want to keep, unlike a one-off tool run.",
  },
  {
    id: "account",
    question: "Do I need to create an account?",
    answer:
      "Not for the browser-based tools — open one and start straight away. An account is only needed for a Workspace, where documents, folders, version history and the editor's saved sessions live.",
  },
  {
    id: "tools",
    question: "What PDF tools are available?",
    answer:
      "Merge, split, organize, rotate, crop, edit, annotate, sign, add page numbers and watermarks, and convert images to PDF all run in your browser. Compression, OCR, repair, password protection, unlocking, flattening and conversion to and from Office formats run on our servers. A few tools are still in development and are listed separately so it is clear what you can use today.",
  },
  {
    id: "editing",
    question: "Can I edit a PDF, not just convert it?",
    answer:
      "Yes. The editor handles text, images, shapes, highlights, signatures and annotations, with page organization, layers and full undo history — in the browser, with nothing to install.",
  },
];
