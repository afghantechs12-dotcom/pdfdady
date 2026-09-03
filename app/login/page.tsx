import type { Metadata } from "next";
import { AuthShell } from "@/components/auth/AuthShell";
import { LoginForm } from "@/components/auth/LoginForm";
import { redirectIfAuthenticated } from "@/src/application/services/authSession";
import { safeRedirectPath } from "@/src/application/services/authValidation";
import { resolveReturnTo } from "@/components/auth/returnTo";

export const metadata: Metadata = {
  title: "Sign in",
  description: "Sign in to your PDFDadi workspace to edit, organize and collaborate on documents.",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * /login — the page an unauthenticated visitor is redirected to.
 *
 * The destination is sanitized here as well as on submit, so the value handed
 * to the form (and embedded in the register link) is already known to be a safe
 * internal path. `returnTo` is accepted as an alias for `next` so that a link
 * built for the public site's conventions works on both auth pages. An
 * already-authenticated visitor is bounced to their workspaces rather than
 * shown a form they do not need.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; returnTo?: string }>;
}) {
  const params = await searchParams;
  const next = safeRedirectPath(resolveReturnTo(params));
  await redirectIfAuthenticated(next);

  return (
    <AuthShell
      title="Welcome back"
      subtitle="Sign in to continue to your workspaces."
      footer={
        <>
          Need help?{" "}
          <a
            href="/contact"
            className="font-semibold text-primary underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            Contact support
          </a>
        </>
      }
    >
      <LoginForm next={next} />
    </AuthShell>
  );
}
