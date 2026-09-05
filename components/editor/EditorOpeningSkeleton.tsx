import { AsyncStatus } from "@/components/ui/AsyncStatus";

/** Session preparation reserves the editor's frame inside the existing app shell. */
export function EditorOpeningSkeleton({ fileName }: { fileName?: string }) {
  return <section aria-label="Preparing document editor" aria-busy="true" data-editor-opening="skeleton"
    className="flex h-[calc(100vh-56px)] min-h-0 flex-col bg-editor-bg text-editor-text">
    <header className="shrink-0 border-b border-editor-border bg-editor-surface px-4 py-3">
      <AsyncStatus phase="pending" message="Preparing editor" fileName={fileName} />
    </header>
    <div aria-hidden="true" className="flex min-h-11 shrink-0 items-center gap-3 border-b border-editor-border bg-editor-surface px-4">
      {[20, 16, 24, 16].map((width, i) => <div key={i} style={{ width: `${width}%` }} className="h-4 max-w-24 rounded bg-editor-border" />)}
    </div>
    <div aria-hidden="true" className="flex min-h-0 flex-1">
      <aside className="hidden w-[180px] shrink-0 space-y-4 border-r border-editor-border bg-editor-surface p-4 md:block">
        {[0, 1, 2].map(i => <div key={i} className="aspect-[1/1.414] animate-pulse rounded-sm border border-editor-border bg-editor-bg motion-reduce:animate-none" />)}
      </aside>
      <div className="flex min-w-0 flex-1 items-center justify-center p-6">
        <div className="aspect-[1/1.414] max-h-full w-full max-w-md space-y-5 border border-editor-border bg-editor-page p-8 shadow-page">
          {[50, 90, 80, 95, 75].map(width => <div key={width} style={{ width: `${width}%` }} className="h-3 animate-pulse rounded bg-editor-border motion-reduce:animate-none" />)}
        </div>
      </div>
    </div>
  </section>;
}
