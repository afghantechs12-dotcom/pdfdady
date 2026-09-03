import type { Metadata } from "next";
import { AuthShell } from "@/components/auth/AuthShell";
import { SignupForm } from "@/components/auth/SignupForm";
import { redirectIfAuthenticated } from "@/src/application/services/authSession";
import { safeRedirectPath } from "@/src/application/services/authValidation";
import { resolveReturnTo } from "@/components/auth/returnTo";

export const metadata: Metadata = {
  title: "Create your workspace",
  description:
    "Create a PDFDadi account and get a workspace for your documents in seconds.",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * /register — the canonical public registration URL.
 *
 * The launch brief mandates that "Get Started Free" points at
 * `/register?returnTo=/workspaces`. This repository already had a working
 * `/signup` page using `?next=`. Rather than run two registration flows that
 * could drift apart, `/register` renders the SAME form and provisioning path,
 * and simply accepts `returnTo` as an alias for `next`.
 *
 * `/signup` is kept as a permanent redirect to here (see app/signup/page.tsx)
 * so existing links and bookmarks keep working and there is exactly one
 * indexable registration URL. The API side already had this shape:
 * `/api/auth/register` delegates to the `/api/auth/signup` handler.
 *
 * Both parameters are sanitized by `safeRedirectPath`, so a crafted `returnTo`
 * cannot turn this page into an open redirect.
 *
 * The shell footer deliberately carries no legal copy. `SignupForm` already
 * requires an explicit, validated "I agree to the Terms of Service and Privacy
 * Policy" checkbox, which is the consent that actually gates the account. A
 * second passive "By continuing you agree to our Terms" line underneath it
 * stated a *different* consent model for the same action — and named only the
 * Terms, omitting the Privacy Policy the checkbox covers. Two competing
 * statements of what the user agreed to is worse than one clear one, so the
 * page keeps the affirmative checkbox and drops the passive restatement.
 * (Launch polish P2-14.)
 */
export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string; next?: string }>;
}) {
  const params = await searchParams;
  const next = safeRedirectPath(resolveReturnTo(params));
  await redirectIfAuthenticated(next);

  return (
    <AuthShell
      title="Create your workspace"
      subtitle="Start editing and organizing PDFs in a workspace built for real work."
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
      <SignupForm next={next} />
    </AuthShell>
  );
}
