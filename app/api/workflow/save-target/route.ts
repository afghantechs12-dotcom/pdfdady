import { NextResponse, type NextRequest } from "next/server";
import { currentUser } from "@/src/application/services/authSession";
import { resolveSaveDestinations } from "@/src/application/services/workspaceSaveTarget";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/workflow/save-target — where this session may save a tool result.
 *
 * The result surfaces are on public tool pages, which are statically rendered and
 * therefore know nothing about the visitor. This is the one thing they need: the
 * Workspaces they may write to, and which of them the account calls home.
 *
 * It takes NO input. A destination the caller asked for is a destination the
 * caller could get wrong (or lie about), so the session decides the SET and the
 * user picks from it; the save routes then re-authorize whichever id comes back.
 * A guest gets `{ destinations: [] }` with a 200, not a 401 — "you are not signed
 * in" is a state this UI renders (a sign-in link beside the download), not an
 * error it recovers from.
 *
 * Every destination is already membership-scoped, organization-scoped and active
 * (`WorkspaceService.list`), so the browser never receives a Workspace it would
 * have to filter out — the filtering happens at this boundary or not at all.
 */
export async function GET(_request: NextRequest) {
  const user = await currentUser();
  const { destinations, defaultWorkspaceId } = user
    ? await resolveSaveDestinations(user.id)
    : { destinations: [], defaultWorkspaceId: null };
  return NextResponse.json(
    { authenticated: user !== null, destinations, defaultWorkspaceId },
    { headers: { "Cache-Control": "no-store" } },
  );
}
