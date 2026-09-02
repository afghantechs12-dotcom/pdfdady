import { LoginForm } from "@/components/admin/LoginForm";
import { Logo } from "@/components/layout/Logo";
import { redirect } from "next/navigation";
import { readStore } from "@/data/admin";
import { isAdminPasswordSet } from "@/lib/admin/passwords";

// Admin pages read the store (fs) and branch on first-run state, so they must
// render at request time — never be statically prerendered at build time.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Admin Login — PDFDadi",
  robots: { index: false, follow: false },
};

export default async function AdminLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  // First-run gate: if no admin password is configured yet, send the operator
  // to /admin/setup rather than showing a login form that can never succeed.
  // (PDFDadi ships with no default password — see lib/admin/passwords.ts.)
  const store = await readStore();
  if (!isAdminPasswordSet(store.settings.adminPasswordHash)) {
    redirect("/admin/setup");
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-lavender-gradient px-5">
      <div className="w-full max-w-md rounded-card border border-softborder bg-white p-8 shadow-card sm:p-10">
        <div className="flex flex-col items-center text-center">
          <Logo size="lg" />
          <p className="mt-4 text-xs font-semibold uppercase tracking-wider text-primary">
            Admin Panel
          </p>
          <h1 className="mt-2 text-2xl font-bold text-navy">Sign in to PDFDadi</h1>
          <p className="mt-2 text-sm text-navy-soft">
            Manage tools, blog, SEO and every page of the site.
          </p>
        </div>
        <LoginForm searchParams={searchParams} />
      </div>
    </main>
  );
}
