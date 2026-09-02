"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { takeHandoffFile } from "@/lib/utils/fileHandoff";

export interface UploadError {
  fileName: string;
  code: "INVALID_TYPE" | "TOO_LARGE" | "TOO_MANY_FILES";
  message: string;
}

interface UseFileUploadConfig {
  accept: string[]; // allowed MIME types
  maxSizeBytes?: number;
  maxFiles?: number;
  multiple?: boolean;
}

const DEFAULT_MAX_SIZE = 50 * 1024 * 1024;

/**
 * Browsers report an empty or generic MIME for files without an OS type
 * association (common on Linux and for drag-and-drop). The server's
 * validateUpload deliberately tolerates these and relies on magic-byte
 * sniffing; mirror that here so valid files aren't rejected client-side.
 */
function typeAllowed(fileType: string, accept: string[]): boolean {
  if (fileType === "" || fileType === "application/octet-stream") return true;
  return accept.includes(fileType);
}

export function validateFiles(
  incoming: File[],
  cfg: Required<UseFileUploadConfig>,
): { accepted: File[]; errors: UploadError[] } {
  const accepted: File[] = [];
  const errors: UploadError[] = [];

  if (!cfg.multiple && incoming.length > 1) {
    return {
      accepted: [],
      errors: [
        {
          fileName: "*",
          code: "TOO_MANY_FILES",
          message: "Only one file is allowed for this tool.",
        },
      ],
    };
  }

  if (incoming.length > cfg.maxFiles) {
    errors.push({
      fileName: "*",
      code: "TOO_MANY_FILES",
      message: `You can add up to ${cfg.maxFiles} files.`,
    });
  }

  for (const file of incoming.slice(0, cfg.maxFiles)) {
    if (!typeAllowed(file.type, cfg.accept)) {
      errors.push({
        fileName: file.name,
        code: "INVALID_TYPE",
        message: `"${file.name}" is not a supported file type.`,
      });
      continue;
    }
    if (file.size > cfg.maxSizeBytes) {
      errors.push({
        fileName: file.name,
        code: "TOO_LARGE",
        message: `"${file.name}" exceeds the size limit.`,
      });
      continue;
    }
    accepted.push(file);
  }

  return { accepted, errors };
}

interface UploadState {
  files: File[];
  errors: UploadError[];
}

export function useFileUpload(config: UseFileUploadConfig) {
  const acceptKey = config.accept.join(",");
  const cfg: Required<UseFileUploadConfig> = useMemo(
    () => ({
      accept: acceptKey ? acceptKey.split(",") : [],
      maxSizeBytes: config.maxSizeBytes ?? DEFAULT_MAX_SIZE,
      maxFiles: config.maxFiles ?? (config.multiple ? 20 : 1),
      multiple: config.multiple ?? false,
    }),
    [acceptKey, config.maxSizeBytes, config.maxFiles, config.multiple],
  );

  // Files and errors live in ONE state value so every transition is a pure
  // updater (no setState-inside-setState side effects) and errors can never
  // go stale relative to the file list.
  const [state, setState] = useState<UploadState>({ files: [], errors: [] });

  const addFiles = useCallback(
    (incoming: File[]) => {
      setState((prev) => {
        const base = cfg.multiple ? prev.files : [];
        const { accepted, errors } = validateFiles([...base, ...incoming], cfg);
        return { files: accepted, errors };
      });
    },
    [cfg],
  );

  const removeFile = useCallback((index: number) => {
    setState((prev) => ({
      files: prev.files.filter((_, i) => i !== index),
      errors: [], // clear stale messages once the offending state is gone
    }));
  }, []);

  const reset = useCallback(() => {
    setState({ files: [], errors: [] });
  }, []);

  // Consume a file handed off from the homepage hero uploader (one-shot).
  // Gated to PDF-accepting hooks so e.g. a signature-image uploader on the
  // same page never swallows it; validation still runs via addFiles.
  useEffect(() => {
    if (!cfg.accept.includes("application/pdf")) return;
    const handoff = takeHandoffFile();
    if (handoff) addFiles([handoff]);
  }, [cfg, addFiles]);

  const setErrors = useCallback((errors: UploadError[]) => {
    setState((prev) => ({ ...prev, errors }));
  }, []);

  return {
    files: state.files,
    errors: state.errors,
    addFiles,
    removeFile,
    reset,
    setErrors,
    config: cfg,
  };
}
