import { Logo } from "@/components/layout/Logo";
import { SetupForm } from "@/components/admin/SetupForm";
import { redirect } from "next/navigation";
import { readStore } from "@/data/admin";
import { isAdminPasswordSet } from "@/lib/admin/passwords";

// Admin pages read the store (fs) and branch on first-run state, so they must
// render at request time — never be statically prerendered at build time.
export const dynamic = "force-dynamic";

export const metadata = {
  title: { absolute: "Admin Setup — PDFDadi" },
  robots: { index: false, follow: false },
};

/**
 * First-run admin setup page. Reachable WITHOUT a session (see proxy.ts) so the
 * very first admin password can be configured. If a password is already set,
 * redirects to login — setup is a one-time bootstrap, not a re-entry point.
 */
export default async function AdminSetupPage() {
  const store = await readStore();
  if (isAdminPasswordSet(store.settings.adminPasswordHash)) {
    redirect("/admin/login");
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-lavender-gradient px-5">
      <div className="w-full max-w-md rounded-card border border-softborder bg-white p-8 shadow-card sm:p-10">
        <div className="flex flex-col items-center text-center">
          <Logo size="lg" />
          <p className="mt-4 text-xs font-semibold uppercase tracking-wider text-primary">
            First-run setup
          </p>
          <h1 className="mt-2 text-2xl font-bold text-navy">Set the admin password</h1>
          <p className="mt-2 text-sm text-navy-soft">
            Choose the password used to access the PDFDadi admin panel. You will use it to sign in on every visit. PDFDadi ships with no default password, so this step is required once.
          </p>
        </div>
        <SetupForm />
      </div>
    </main>
  );
}
