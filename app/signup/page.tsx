import { permanentRedirect } from "next/navigation";
import { resolveReturnTo } from "@/components/auth/returnTo";
import { safeRedirectPath } from "@/src/application/services/authValidation";

export const dynamic = "force-dynamic";

/**
 * /signup — permanently redirects to the canonical /register.
 *
 * The launch brief fixes `/register?returnTo=…` as the public registration URL.
 * Rather than maintain two pages rendering the same form (which would
 * inevitably drift), the older path redirects. 308 rather than 301 because it
 * guarantees the request method is preserved.
 *
 * The requested destination is carried across, so `/signup?next=/workspaces/abc`
 * does not lose the user's place. It is sanitized with `safeRedirectPath` on the
 * way through: this redirect must not be usable to launder a hostile value into
 * the register page.
 */
export default async function SignupRedirectPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string; next?: string }>;
}) {
  const params = await searchParams;
  const requested = resolveReturnTo(params);

  if (requested) {
    const safe = safeRedirectPath(requested);
    permanentRedirect(`/register?returnTo=${encodeURIComponent(safe)}`);
  }

  permanentRedirect("/register");
}
