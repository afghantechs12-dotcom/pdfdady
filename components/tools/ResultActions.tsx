"use client";

import { CheckCircle2, Download, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { formatBytes } from "@/lib/utils/formatBytes";
import { downloadBlob } from "@/lib/utils/download";
import { useToolFunnel, useToolSlug } from "@/components/tools/ToolAnalyticsProvider";
import { ResultWorkflowActions } from "@/components/tools/ResultWorkflowActions";
import type { ResultSaveTarget } from "@/components/tools/resultWorkflow";
import type { ProcessedResult } from "@/lib/pdf/types";
import { saveIntentKeyForTarget } from "@/lib/workflow/saveIntent";

interface ResultActionsProps {
  result: ProcessedResult;
  onReset: () => void;
}

/**
 * The success state for every local tool — and therefore where `download` is
 * reported from.
 *
 * The step used to be an optional `onDownload` prop, which meant eleven runners
 * each had to remember to pass a tracker and only one did. This component is the
 * single place in the product that hands a locally-produced file to the browser,
 * so it is the only place the step can be both complete and honest: it fires when
 * a download actually happens, never when a result is merely rendered.
 *
 * The order below is the requirement: `downloadBlob` first, the beacon second, so
 * nothing about analytics can cost the user the file they just asked for.
 */
export function ResultActions({ result, onReset }: ResultActionsProps) {
  const funnel = useToolFunnel();
  const toolSlug = useToolSlug();
  return (
    <div className="flex flex-col items-start gap-5 text-left">
      <span className="inline-flex h-14 w-14 items-center justify-center rounded-full bg-green-50 text-success">
        <CheckCircle2 size={30} />
      </span>
      <div>
        <p role="status" className="text-lg font-semibold text-navy">Your file is ready</p>
        <p className="mt-2 break-words text-base font-medium text-navy">
          {result.fileName} · {formatBytes(result.blob.size)}
        </p>
      </div>
      <div className="flex flex-col gap-3 sm:flex-row">
        <Button
          size="lg"
          leadingIcon={<Download size={18} />}
          onClick={() => {
            downloadBlob(result.blob, result.fileName);
            funnel.noteDownload(extensionOf(result.fileName));
          }}
        >
          Download
        </Button>
        <Button
          size="lg"
          variant="outline"
          leadingIcon={<RotateCcw size={16} />}
          onClick={onReset}
        >
          Start over
        </Button>
      </div>

      {/*
       * The workflow half of the same panel: what this file can BECOME, next to
       * what it can be saved as. Which of those CTAs appear is decided by the
       * tool's capability record inside `ResultWorkflowActions` — this file adds
       * no conditions of its own, so a tool cannot gain or lose an action here by
       * accident.
       *
       * Both ports read the blob this component already holds. `loadBytes` is
       * called only when the user presses `Open in Editor`, and `save` only on
       * `Save to Workspace`: a local result that is merely LOOKED at still leaves
       * the browser untouched, which is the promise the tool page makes.
       */}
      <ResultWorkflowActions
        toolSlug={toolSlug}
        fileName={result.fileName}
        outputMimeType={result.mimeType}
        loadBytes={async () => new Uint8Array(await result.blob.arrayBuffer())}
        save={(target) => saveLocalResult(target, result, toolSlug)}
      />
    </div>
  );
}

/**
 * Uploads a locally-produced result into a Workspace, through the SAME endpoint
 * the editor's first save uses.
 *
 * No dedicated "save result" route: this one already enforces CSRF, membership,
 * organization scoping and the upload ceiling. A new endpoint would have had to
 * re-earn all four.
 *
 * `saveIntentKey` is what makes a second press cheap and a second SAVE possible.
 * The key belongs to this result AND to the chosen destination, so every retry of
 * this press converges on the one document it made while the same result saved into
 * a second Workspace is allowed to be its own save; a different result, or a re-run of the same tool, carries a
 * different key and is allowed to become its own document even when the bytes are
 * identical. Without it the server would fall back to content dedup, which is what
 * used to answer a deliberate second save with the first document under the first
 * name. `saveIntentSource` is the tool, so one key cannot be replayed for another
 * tool's output.
 *
 * `organizationId` is sent because the server resolved it for this session (see
 * `/api/workflow/save-target`); the route re-checks membership for it either way.
 */
function saveLocalResult(
  target: ResultSaveTarget,
  result: ProcessedResult,
  toolSlug: string | null,
): Promise<Response> {
  const form = new FormData();
  form.append("file", result.blob, result.fileName);
  form.append("name", result.fileName);
  form.append("organizationId", target.organizationId);
  if (result.saveIntentKey) {
    form.append("saveIntentKey", saveIntentKeyForTarget(result.saveIntentKey, target.workspaceId));
    form.append("saveIntentSource", toolSlug ?? "local-result");
  }
  return fetch(`/api/workspaces/${encodeURIComponent(target.workspaceId)}/documents/upload`, {
    method: "POST",
    body: form,
  });
}

/** The produced format, from the filename. "pdf" for everything local today. */
function extensionOf(fileName: string): string {
  return fileName.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() ?? "bin";
}
