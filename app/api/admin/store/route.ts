import { NextResponse } from "next/server";
import { readStore } from "@/data/admin";
import { requireAdmin } from "../_guard";

/**
 * Dump the merged admin store (defaults + overrides) to the dashboard. Requires
 * a valid admin session, and the sensitive `settings` block (password hash) is
 * stripped from the response so it never leaves the server.
 */
export async function GET(req: Request) {
  const guard = await requireAdmin(req);
  if (guard) return guard;
  const store = await readStore();
  const { settings: _settings, ...safe } = store;
  void _settings;
  return NextResponse.json(safe);
}
