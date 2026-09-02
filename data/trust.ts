export interface TrustItem {
  id: string;
  title: string;
  description: string;
  icon: string; // lucide-react icon name
}

/**
 * The security and privacy strip.
 *
 * No fake user counts, no "trusted by millions", and — since the launch review
 * — no unqualified performance or privacy guarantee either. "Fast processing /
 * Get results in seconds" was a timing promise that depends on file size and
 * tool (docs/launch-feature-evidence.md, C7), and "Private by design / Your
 * data stays yours" (C10) said nothing a visitor could check.
 *
 * Each entry now states a behaviour that is either visible in the product or
 * enforced in code. Absent by design: any compliance certification, any
 * encryption claim beyond transport, and any automatic-deletion promise, none
 * of which are implemented.
 */
export const trustItems: TrustItem[] = [
  {
    id: "stated",
    title: "Stated before you start",
    description:
      "Each tool shows where it runs — your browser or our servers — before you pick a file.",
    icon: "ShieldCheck",
  },
  {
    id: "account",
    title: "An account is optional",
    description:
      "Browser tools work signed out. You only need one to keep documents in a Workspace.",
    icon: "LockOpen",
  },
  {
    id: "yours",
    title: "Your Workspace, your call",
    description:
      "Saved documents stay until you archive or delete them. Deleted items go to trash, where you can restore them.",
    icon: "FolderKanban",
  },
  {
    id: "transport",
    title: "Encrypted in transit",
    description:
      "Anything sent to our servers travels over HTTPS, including uploads and downloads.",
    icon: "Lock",
  },
];
