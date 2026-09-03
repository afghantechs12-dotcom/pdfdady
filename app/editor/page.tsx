import type { Metadata } from "next";
import { StandaloneEditorShell } from "@/components/editor/StandaloneEditorShell";
import { currentUser } from "@/src/application/services/authSession";
import { resolveSaveTarget } from "@/src/application/services/workspaceSaveTarget";

export const metadata: Metadata = {
  title: "PDF Editor",
  description:
    "PDFDadi's premium visual PDF editor: add and edit text, images, shapes, highlights, signatures, and annotations on your PDF with professional selection, snapping, layers, and history.",
  robots: { index: false, follow: false },
};

// Reads the session cookie, so it cannot be statically rendered. The public
// marketing routes (`/`, `/tools`) are unaffected — this is its own route.
export const dynamic = "force-dynamic";

/**
 * The `/editor` route — the standalone visual PDF editor.
 *
 * Unauthenticated visitors are explicitly supported: the editor is a
 * client-side application that opens a local file, so guest editing needs no
 * session. Signing in only adds the ability to save the result into a
 * Workspace.
 */
export default async function EditorPage() {
  const user = await currentUser();
  const saveTarget = user ? await resolveSaveTarget(user.id) : null;

  return (
    // `id="main"` because the root layout's "Skip to content" link targets it on
    // every route and this route supplies no other shell. Before this it resolved
    // to nothing here — `document.getElementById("main")` was null on /editor —
    // so the one bypass mechanism the page had was inert (WCAG 2.4.1). The editor
    // frame used to spend the `<main>` on its canvas region, which both left this
    // route without a landmark and nested a second `main` inside AppShell's on the
    // Workspace editor.
    <main id="main" className="fixed inset-0 z-editor bg-white">
      <StandaloneEditorShell
        viewer={{ email: user?.email ?? null, name: user?.name ?? null }}
        saveTarget={saveTarget}
      />
    </main>
  );
}
