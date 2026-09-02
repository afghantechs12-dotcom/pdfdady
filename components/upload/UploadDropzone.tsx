"use client";

import { useRef, useState, useId } from "react";
import { FileUp, FileText, Image as ImageIcon, X, AlertCircle } from "lucide-react";
import { formatBytes } from "@/lib/utils/formatBytes";
import { cn } from "@/lib/utils/cn";
import type { UploadError } from "@/hooks/useFileUpload";

interface UploadDropzoneProps {
  accept: string[];
  multiple?: boolean;
  files: File[];
  errors: UploadError[];
  onAddFiles: (files: File[]) => void;
  onRemoveFile: (index: number) => void;
  title?: string;
  subtitle?: string;
  trustText?: string;
  acceptHint?: string;
  /**
   * `hero` and `tool` are the tall, centred drop targets. `inline` is a compact
   * single-row control for placing the same functionality inside a dense layout
   * — it exists so the homepage hero can keep a real drop target without the
   * 200px-tall panel that was the page's single largest source of whitespace.
   */
  variant?: "hero" | "tool" | "inline";
  disabled?: boolean;
  /**
   * id applied to the interactive drop target itself, so a call to action
   * elsewhere on the page can move focus here rather than only scrolling to it.
   */
  dropzoneId?: string;
}

export function UploadDropzone({
  accept,
  multiple = false,
  files,
  errors,
  onAddFiles,
  onRemoveFile,
  title = "Drop your PDF here",
  subtitle = "or click to browse",
  // Was "Secure processing • Auto deletion". The second half described a
  // retention job that does not exist, on every upload control on the site.
  // What replaces it is true of every tool: the tool page states its own mode.
  trustText = "Every tool states where it runs",
  acceptHint,
  variant = "tool",
  disabled = false,
  dropzoneId,
}: UploadDropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const errorId = useId();

  const openPicker = () => {
    if (!disabled) inputRef.current?.click();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (disabled) return;
    const dropped = Array.from(e.dataTransfer.files);
    if (dropped.length) onAddFiles(dropped);
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(e.target.files ?? []);
    if (selected.length) onAddFiles(selected);
    e.target.value = ""; // allow re-selecting the same file
  };

  const isImageTool = accept.some((t) => t.startsWith("image/"));
  const FileIcon = isImageTool ? ImageIcon : FileText;
  const inline = variant === "inline";
  const padding = inline
    ? "px-4 py-3.5"
    : variant === "hero"
      ? "px-6 py-14"
      : "px-6 py-12";

  return (
    <div className="w-full">
      <input
        ref={inputRef}
        type="file"
        accept={accept.join(",")}
        multiple={multiple}
        onChange={handleChange}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
      />

      <div
        id={dropzoneId}
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-label={`${title}. ${subtitle}`}
        aria-disabled={disabled}
        aria-describedby={errors.length ? errorId : undefined}
        onClick={openPicker}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openPicker();
          }
        }}
        onDragEnter={(e) => {
          e.preventDefault();
          if (!disabled) setIsDragging(true);
        }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        className={cn(
          "flex border-2 border-dashed transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2 motion-reduce:transition-none",
          inline
            ? "items-center gap-3 rounded-[18px] text-left"
            : "flex-col items-center justify-center gap-4 rounded-[22px] text-center",
          // Keeps the sticky header off the control when a fragment link
          // scrolls focus here.
          "scroll-mt-24",
          padding,
          disabled
            ? "cursor-not-allowed border-softborder bg-lavender/40 opacity-70"
            : "cursor-pointer border-primary/30 bg-lavender/50 hover:border-primary/60 hover:bg-lavender",
          isDragging && !disabled && "border-primary bg-primary-soft",
        )}
      >
        <span
          className={cn(
            "inline-flex shrink-0 items-center justify-center bg-primary text-white shadow-card",
            inline ? "h-10 w-10 rounded-xl" : "h-16 w-16 rounded-2xl",
          )}
        >
          <FileUp size={inline ? 18 : 28} aria-hidden="true" />
        </span>
        <div className={inline ? "min-w-0" : undefined}>
          <p
            className={cn(
              "font-semibold text-navy",
              inline ? "text-sm" : "text-lg",
            )}
          >
            {title}
          </p>
          {/* Inline folds the hint onto one line: two stacked captions inside a
              56px control is the tall layout again, just smaller. */}
          <p
            className={cn(
              "text-navy-soft",
              inline ? "text-xs" : "mt-1 text-sm",
            )}
          >
            {subtitle}
            {inline && acceptHint ? ` · ${acceptHint}` : ""}
          </p>
          {!inline && acceptHint && (
            <p className="mt-2 text-xs text-navy-soft">{acceptHint}</p>
          )}
        </div>
      </div>

      <p
        className={cn(
          "text-xs font-medium text-navy-soft",
          inline ? "mt-2" : "mt-3 text-center",
        )}
      >
        {trustText}
      </p>

      {/* Errors */}
      {errors.length > 0 && (
        <div id={errorId} role="alert" className="mt-4 space-y-2">
          {errors.map((err, i) => (
            <div
              key={`${err.fileName}-${i}`}
              className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
            >
              <AlertCircle size={16} className="mt-0.5 shrink-0" />
              <span>{err.message}</span>
            </div>
          ))}
        </div>
      )}

      {/* Selected files */}
      {files.length > 0 && (
        <ul className="mt-4 space-y-2">
          {files.map((file, i) => (
            <li
              key={`${file.name}-${i}`}
              className="flex items-center gap-3 rounded-xl border border-softborder bg-white px-3 py-2.5 shadow-card"
            >
              <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary">
                <FileIcon size={18} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-navy">
                  {file.name}
                </p>
                <p className="text-xs text-navy-soft">
                  {formatBytes(file.size)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => onRemoveFile(i)}
                aria-label={`Remove ${file.name}`}
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-navy-soft transition-colors hover:bg-red-50 hover:text-red-600"
              >
                <X size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
