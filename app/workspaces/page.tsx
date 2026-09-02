import Link from "next/link";
import { ArrowRight, FolderKanban, PenLine, Wrench } from "lucide-react";
import { AppCard, EmptyState } from "@/components/app/primitives";
import { AppUserMenu } from "@/components/app/AppUserMenu";
import { WorkspaceCreateDialog } from "@/components/workspaces/WorkspaceCreateDialog";
import { workspaceHref } from "@/components/app/appShellLogic";
import { BRAND, brandTitle } from "@/lib/brand";
import { LogoMark } from "@/components/layout/Logo";
import { workspacePageActor, pageWorkspaceService } from "@/src/application/services/workspacePageData";

export const metadata = { title: brandTitle("Workspaces"), robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/**
 * The Workspace picker.
 *
 * This route sits before a Workspace is chosen, so it cannot render the full
 * application shell (whose sidebar is scoped to one Workspace). It uses a
 * minimal authenticated chrome instead — deliberately not the public marketing
 * header, which would put a "Get Started Free" button in front of a signed-in
 * user.
 *
 * The launch review flagged this page as looking detached from the product
 * (screenshot 3). Two substantive fixes, beyond spacing:
 *
 *  - **There was no account control at all.** A user who landed here could not
 *    see who they were signed in as and had no way to sign out without finding
 *    their way into a Workspace first. The shared `AppUserMenu` — the same one
 *    the application sidebar uses — now sits in the header.
 *  - **The cards carried no information.** Only a name and a fallback
 *    description. They now show the actor's role, which is real data already
 *    resolved for the authorization check. Document counts and "last opened"
 *    are deliberately NOT shown: the list endpoint does not return them, and
 *    fetching per-card counts would mean N queries to decorate a picker. An
 *    invented number is worse than an absent one.
 */
export default async function WorkspacesPage({
  searchParams,
}: {
  searchParams: Promise<{ organizationId?: string }>;
}) {
  const query = await searchParams;
  const { org, actor, user } = await workspacePageActor(query.organizationId);
  const { items } = await pageWorkspaceService().list(actor);

  return (
    <div className="flex min-h-screen flex-col bg-app-bg">
      <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-app-border bg-app-surface px-4 sm:px-6">
        <Link
          href="/"
          aria-label={`${BRAND.name} home`}
          className="flex items-center gap-2 rounded-control focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          <LogoMark size={28} />
          <span className="text-[15px] font-bold tracking-tight text-app-text">
            {BRAND.wordmark.lead}
            <span className="bg-gradient-to-r from-primary to-aipink bg-clip-text text-transparent">
              {BRAND.wordmark.accent}
            </span>
          </span>
        </Link>

        <div className="w-56">
          <AppUserMenu name={user.name} email={user.email} tone="light" />
        </div>
      </header>

      <main id="main" className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6 sm:py-12">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-primary">{org.name}</p>
            <h1 className="mt-1 text-2xl font-bold tracking-tight text-app-text">Workspaces</h1>
            <p className="mt-1 text-sm text-app-muted">
              Choose a Workspace to open, or create a new one.
            </p>
          </div>
          <WorkspaceCreateDialog organizationId={org.id} />
        </div>

        {items.length === 0 ? (
          <AppCard className="mt-8 p-0">
            <EmptyState
              icon={<FolderKanban size={22} aria-hidden="true" />}
              title="No Workspaces yet"
              description="A Workspace is where your documents live — with folders, tags, version history and the editor. Create one to get started."
              actions={<WorkspaceCreateDialog organizationId={org.id} />}
            />
          </AppCard>
        ) : (
          <ul className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {items.map((item) => (
              <li key={item.id}>
                <Link
                  href={workspaceHref(item.id, org.id)}
                  className="group flex h-full flex-col gap-2 rounded-appcard border border-app-border bg-app-surface p-4 shadow-appcard transition-all hover:border-primary/30 hover:shadow-appcardhover focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none"
                >
                  <span className="flex items-center justify-between">
                    <span
                      aria-hidden="true"
                      className="grid h-9 w-9 place-items-center rounded-control bg-gradient-to-br from-primary to-aipink text-sm font-bold text-white"
                    >
                      {item.name.trim().charAt(0).toUpperCase()}
                    </span>
                    <ArrowRight
                      size={16}
                      aria-hidden="true"
                      className="text-app-muted opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none"
                    />
                  </span>
                  <span className="text-[15px] font-bold text-app-text">{item.name}</span>
                  <span className="text-sm text-app-muted">
                    {item.description ?? "Document workspace"}
                  </span>
                  <span className="mt-auto flex flex-wrap items-center gap-1.5 pt-2">
                    {/*
                      The organization role, which the page already resolved to
                      authorize this request — not a per-workspace membership
                      role, which the list endpoint does not return.
                    */}
                    <span className="inline-flex rounded-full bg-app-bg px-2 py-0.5 text-[11px] font-semibold capitalize text-app-muted">
                      {actor.organizationRole}
                    </span>
                    {item.lifecycleState !== "active" && (
                      <span className="inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold capitalize text-slate-700">
                        {item.lifecycleState}
                      </span>
                    )}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}

        {/* Where to go next — the picker previously dead-ended if you did not
            want to open a Workspace at all. */}
        <nav aria-label="Elsewhere" className="mt-10 grid gap-3 sm:grid-cols-2">
          <Link
            href="/tools"
            className="flex items-center gap-3 rounded-appcard border border-app-border bg-app-surface p-4 text-left transition-colors hover:border-primary/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none"
          >
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-control bg-app-bg text-primary">
              <Wrench size={17} aria-hidden="true" />
            </span>
            <span>
              <span className="block text-sm font-semibold text-app-text">
                PDF tools
              </span>
              <span className="block text-sm text-app-muted">
                Merge, split, compress and convert without opening a Workspace.
              </span>
            </span>
          </Link>
          <Link
            href="/editor"
            className="flex items-center gap-3 rounded-appcard border border-app-border bg-app-surface p-4 text-left transition-colors hover:border-primary/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none"
          >
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-control bg-app-bg text-primary">
              <PenLine size={17} aria-hidden="true" />
            </span>
            <span>
              <span className="block text-sm font-semibold text-app-text">
                Editor
              </span>
              <span className="block text-sm text-app-muted">
                Open the editor directly on a file from your device.
              </span>
            </span>
          </Link>
        </nav>
      </main>
    </div>
  );
}
