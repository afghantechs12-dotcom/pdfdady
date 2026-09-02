/**
 * Post-authentication destination parameter handling.
 *
 * Two names are in play. `next` is what this repository's auth pages and API
 * routes have always used; `returnTo` is what the launch brief mandates for the
 * public "Get Started Free" call to action. Supporting both is cheaper and
 * safer than renaming a parameter that is already embedded in working redirect
 * logic, tests and links.
 *
 * This module resolves the two into one value. It performs NO security
 * validation — callers must pass the result through `safeRedirectPath`, which
 * is the single open-redirect boundary. Splitting "which parameter" from "is it
 * safe" keeps that boundary in one place.
 */
export interface ReturnToParams {
  returnTo?: string | string[];
  next?: string | string[];
}

/** Takes the first value when a query parameter is repeated (`?next=a&next=b`). */
function firstValue(value: string | string[] | undefined): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0] ?? null;
  return null;
}

/**
 * Resolves the requested destination, preferring `returnTo` when both are
 * present — it is the documented public contract, so a link that carries it
 * expresses the more deliberate intent.
 */
export function resolveReturnTo(params: ReturnToParams): string | null {
  return firstValue(params.returnTo) ?? firstValue(params.next);
}
