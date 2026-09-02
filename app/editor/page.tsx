import type { Metadata } from "next";
import { StandaloneEditorShell } from "@/components/editor/StandaloneEditorShell";
import { currentUser } from "@/src/application/services/authSession";
import { resolveSaveTarget } from "@/src/application/services/workspaceSaveTarget";

export const metadata: Metadata = {
  title: "PDF Editor — PDFDadi",
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
    <div className="fixed inset-0 z-editor bg-white">
      <StandaloneEditorShell
        viewer={{ email: user?.email ?? null, name: user?.name ?? null }}
        saveTarget={saveTarget}
      />
    </div>
  );
}
