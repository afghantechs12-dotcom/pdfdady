"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { UploadDropzone } from "@/components/upload/UploadDropzone";
import { Button } from "@/components/ui/Button";
import { useFileUpload } from "@/hooks/useFileUpload";
import { setHandoffFile } from "@/lib/utils/fileHandoff";

/**
 * The quick destinations offered after a file is dropped on the homepage.
 *
 * Passed in from the server rather than imported here. This component is a
 * client component, so a module-scope `import { tools } from "@/data/tools"`
 * pulled the entire 598-line, 45-entry catalog — every slug, description, icon
 * name and MIME list — into the homepage's client bundle in order to render
 * four links. The server already has that data at render time.
 */
export interface QuickTool {
  slug: string;
  name: string;
  href: string;
}

/**
 * The id of the drop target itself.
 *
 * The hero's primary call to action links here. Because the drop target is
 * `tabIndex=0`, fragment navigation moves keyboard focus onto it rather than
 * merely scrolling the page — so "Choose PDF File" leaves a keyboard user on
 * the control they asked for, and Enter opens the file picker immediately.
 * Previously the anchor pointed at the wrapping div, which is not focusable,
 * and focus stayed behind on the button.
 */
export const HERO_DROPZONE_ID = "hero-dropzone";

export function HeroUpload({
  quickTools,
  variant = "panel",
}: {
  quickTools: QuickTool[];
  /**
   * `panel` is the original standalone card. `inline` is the compact row that
   * sits inside the hero's copy column — same drop target, same handoff, but
   * without the 200px-tall white card that made the hero's neighbour read as
   * empty space. The standalone panel is gone from the homepage; the variant
   * stays because the control is generic.
   */
  variant?: "panel" | "inline";
}) {
  const upload = useFileUpload({ accept: ["application/pdf"], multiple: false });
  const file = upload.files[0];
  const maxMb = Math.round(upload.config.maxSizeBytes / (1024 * 1024));
  const inline = variant === "inline";

  const dropzone = (
    <UploadDropzone
      dropzoneId={HERO_DROPZONE_ID}
      accept={["application/pdf"]}
      variant={inline ? "inline" : "hero"}
      files={upload.files}
      errors={upload.errors}
      onAddFiles={upload.addFiles}
      onRemoveFile={upload.removeFile}
      title={inline ? "Drop a PDF to start" : "Drop your PDF here"}
      subtitle="or click to browse"
      // Stating the limit up front is cheaper than letting someone pick a
      // 200 MB file and reading an error afterwards.
      acceptHint={`PDF files up to ${maxMb} MB`}
    />
  );

  const picker = (
    <div className="mt-4">
      <p className="text-sm font-semibold text-navy">Choose a tool to continue</p>
      <div className="mt-3 grid grid-cols-2 gap-2">
        {quickTools.map((t) => (
          <Link
            key={t.slug}
            href={t.href}
            // Carry the dropped file to the tool page so the user
            // doesn't have to upload it a second time.
            onClick={() => setHandoffFile(file!)}
            className="rounded-button border border-softborder bg-white px-3 py-2 text-center text-sm font-medium text-navy transition-colors hover:border-primary hover:text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
          >
            {t.name}
          </Link>
        ))}
      </div>
      <Button
        href="/tools"
        variant="ghost"
        size="sm"
        fullWidth
        trailingIcon={<ArrowRight size={15} aria-hidden="true" />}
        className="mt-2"
      >
        View all tools
      </Button>
    </div>
  );

  if (inline) {
    return (
      <div>
        {dropzone}
        {file && (
          <div className="mt-3 rounded-[18px] border border-softborder bg-white p-3 shadow-card">
            {picker}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-upload bg-white p-3 shadow-upload">
      {!file ? (
        dropzone
      ) : (
        <div className="rounded-[22px] bg-lavender/40 p-5">
          {dropzone}
          {picker}
        </div>
      )}
    </div>
  );
}
