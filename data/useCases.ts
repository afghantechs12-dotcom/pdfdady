export interface UseCase {
  id: string;
  title: string;
  description: string;
  icon: string; // lucide-react icon name
  /**
   * The concrete workflow this audience runs, as three or four steps.
   *
   * Optional so that a use case created through the admin console — which
   * edits id/title/description/icon only — still renders. Entries without
   * steps fall back to the description alone.
   */
  steps?: string[];
}

/**
 * Homepage use cases.
 *
 * Previously four cards reading "Assignments, notes and study materials." and
 * similar: true of any PDF site, and connected to nothing the product does.
 * Each entry now names the actual tools and Workspace features that audience
 * would use, all of them from §2 of docs/launch-feature-evidence.md.
 *
 * Deliberately absent: anything resembling an enterprise control. There is no
 * SSO, no audit log, no retention policy engine and no team permission model,
 * so no card claims one. "Offices" is described in terms of the multi-document
 * features that do exist.
 */
export const useCases: UseCase[] = [
  {
    id: "students",
    title: "Students",
    description:
      "Pull a term's worth of handouts into one file and study from it.",
    icon: "GraduationCap",
    steps: [
      "Merge lecture notes and handouts into a single PDF",
      "Highlight and annotate as you read",
      "Keep everything in folders by module",
      "Reopen where you left off before an exam",
    ],
  },
  {
    id: "freelancers",
    title: "Freelancers",
    description:
      "Send proposals and contracts you can revise without losing the original.",
    icon: "Briefcase",
    steps: [
      "Edit a proposal's text and pages in the browser",
      "Add a signature and send it out",
      "Restore an earlier version when terms change",
      "Keep each client's documents in their own folder",
    ],
  },
  {
    id: "small-business",
    title: "Small businesses",
    description:
      "Get scanned paperwork into a shape you can actually search.",
    icon: "Store",
    steps: [
      "Run OCR over scanned invoices and receipts",
      "Compress large files before emailing them",
      "Tag documents so they are findable later",
      "Track long-running jobs in the operations panel",
    ],
  },
  {
    id: "offices",
    title: "Offices",
    description:
      "Work across several documents at once without juggling downloads.",
    icon: "Building2",
    steps: [
      "Open documents in tabs and compare two in split view",
      "Leave threaded comments and resolve them",
      "Navigate long files from the outline",
      "Recover unsaved work after a crash",
    ],
  },
];
