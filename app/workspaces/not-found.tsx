import Link from "next/link";
import { FolderX } from "lucide-react";
import { brandTitle } from "@/lib/brand";

export const metadata = {
  title: brandTitle("Workspace not found"),
  robots: { index: false, follow: false },
};

/**
 * The controlled answer for every refused Workspace lookup under `/workspaces`.
 *
 * `WorkspaceService.get` refuses for four different reasons — the id does not
 * exist, it belongs to another organization, the actor has no membership, the id
 * is malformed — and `loadWorkspaceForRoute` collapses all four into this one
 * page on purpose. Distinguishing them here would tell a prober which ids exist,
 * which is precisely the oracle the service layer avoids; the category is only
 * ever written to the server log.
 *
 * Nothing on this page names the id that was requested, and no message from the
 * thrown error reaches it.
 */
export default function WorkspaceNotFound() {
  return (
    <main className="grid min-h-screen place-items-center bg-app-bg px-6">
      <div className="w-full max-w-sm rounded-appcard border border-app-border bg-app-surface p-6 text-center shadow-apppanel">
        <span
          aria-hidden="true"
          className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-appcard bg-app-subtle text-app-muted"
        >
          <FolderX size={20} aria-hidden="true" />
        </span>
        <h1 className="text-[15px] font-bold tracking-tight text-app-text">
          This Workspace is not available
        </h1>
        <p className="mx-auto mt-2 max-w-xs text-[13px] leading-relaxed text-app-muted">
          It may have been removed, or your account may not have access to it. Ask
          a Workspace owner for access, or pick another Workspace.
        </p>
        <Link
          href="/workspaces"
          className="mt-5 inline-flex items-center justify-center rounded-control bg-primary px-3.5 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-primary-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          Go to your Workspaces
        </Link>
      </div>
    </main>
  );
}
