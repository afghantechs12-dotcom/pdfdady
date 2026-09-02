"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { AlertCircle, Command as CommandIcon, Loader2, Search } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import {
  activeDescendantId,
  boundSelection,
  canExecuteCommand,
  commandOptionId,
  disabledReasonText,
  emptyCommandStateText,
  flattenCommandGroups,
  groupCommandsForDisplay,
  isCurrentResponse,
  isQueryWithinBounds,
  normalizeCommandQuery,
  resetSelectionForResults,
  resolveCommandKey,
  shortcutLabel,
  type CommandView,
} from "./commandLogic";

export interface CommandPaletteProps {
  workspaceId: string;
  organizationId: string;
  /** The document the palette would target. Null when nothing is open. */
  activeDocumentId?: string | null;
  /** The pane a command applies to, so it lands in the editor the user is in. */
  activePane?: "left" | "right";
  isSplit?: boolean;
  hasSelection?: boolean;
  /**
   * Called with the resolved target once the server authorized the command. The
   * workbench performs the action; the palette only decides what and where.
   */
  onExecute?: (result: { commandId: string; documentId: string | null; paneId: string }) => void;
}

/**
 * The M7.14 command palette.
 *
 * Three rules from the domain survive into this screen.
 *
 * **A descriptor is not a permission.** The list the palette renders is a
 * catalogue; `enabled` decides only what is greyed out. Pressing Enter posts the
 * command id to a route that re-authorizes against the Workspace and resolves
 * the document itself, so a client that tampered with the displayed state gains
 * nothing.
 *
 * **A disabled command is shown with its reason, never hidden.** Hiding a
 * command a user knows exists reads as the feature having been removed; a greyed
 * row saying "Open a document first" tells them what to do. Arrow keys land on
 * disabled rows for exactly this reason, and Enter on one does nothing.
 *
 * **Errors appear in place, in a live region.** No `alert()` — a blocking dialog
 * steals focus from the palette and cannot be read back in context.
 */
export function CommandPalette({
  workspaceId,
  organizationId,
  activeDocumentId = null,
  activePane = "left",
  isSplit = false,
  hasSelection = false,
  onExecute,
}: CommandPaletteProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [commands, setCommands] = useState<CommandView[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");

  const baseId = useId();
  const inputId = useId();
  const headingId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  // Monotonic request tag: a slow reply that lands after a newer one is dropped
  // rather than overwriting current results.
  const sequenceRef = useRef(0);

  const groups = useMemo(() => groupCommandsForDisplay(commands), [commands]);
  const flat = useMemo(() => flattenCommandGroups(groups), [groups]);

  const load = useCallback(
    async (raw: string) => {
      if (!isQueryWithinBounds(raw)) {
        setError("That search is too long.");
        return;
      }
      const sequence = (sequenceRef.current += 1);
      setLoading(true);
      try {
        const params = new URLSearchParams({
          organizationId,
          q: normalizeCommandQuery(raw),
          hasDocument: String(activeDocumentId !== null),
          hasSelection: String(hasSelection),
          isSplit: String(isSplit),
          activePane,
        });
        if (activeDocumentId !== null) params.set("documentId", activeDocumentId);

        const response = await fetch(
          `/api/workspaces/${encodeURIComponent(workspaceId)}/commands?${params.toString()}`,
        );
        const data = await response.json();
        if (!isCurrentResponse(sequence, sequenceRef.current)) return;
        if (!response.ok) throw new Error(data.error?.message ?? "Commands could not be loaded.");

        setCommands(data.commands as CommandView[]);
        setSelectedIndex(resetSelectionForResults((data.commands as CommandView[]).length));
        setError(null);
      } catch (caught) {
        if (!isCurrentResponse(sequence, sequenceRef.current)) return;
        setError(caught instanceof Error ? caught.message : "Commands could not be loaded.");
      } finally {
        if (isCurrentResponse(sequence, sequenceRef.current)) setLoading(false);
      }
    },
    [workspaceId, organizationId, activeDocumentId, activePane, isSplit, hasSelection],
  );

  useEffect(() => {
    if (!open) return;
    void load(query);
  }, [open, query, load]);

  // Focus the search input once the dialog is mounted, so a keyboard user can
  // type immediately rather than tabbing into it.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Ctrl+K / Cmd+K opens the palette from anywhere in the workspace.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((current) => !current);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setCommands([]);
    setSelectedIndex(-1);
    setError(null);
  }, []);

  const execute = useCallback(
    async (command: CommandView) => {
      if (!canExecuteCommand(command)) return;
      setLoading(true);
      try {
        const response = await fetch(
          `/api/workspaces/${encodeURIComponent(workspaceId)}/commands`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              organizationId,
              commandId: command.id,
              documentId: activeDocumentId,
              paneId: activePane,
            }),
          },
        );
        const data = await response.json();
        // The server decides, not the row's displayed state: a refusal here is
        // reported in place rather than swallowed.
        if (!response.ok) throw new Error(data.error?.message ?? "That command could not run.");

        setAnnouncement(`${command.label} ran.`);
        onExecute?.(data.command);
        close();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "That command could not run.");
      } finally {
        setLoading(false);
      }
    },
    [workspaceId, organizationId, activeDocumentId, activePane, onExecute, close],
  );

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    const outcome = resolveCommandKey(event.key, selectedIndex, flat);
    if (outcome.kind === "ignore") return;
    event.preventDefault();

    if (outcome.kind === "move") setSelectedIndex(boundSelection(outcome.index, flat.length));
    else if (outcome.kind === "close") close();
    else void execute(flat[outcome.index]);
  }

  const activeDescendant = activeDescendantId(baseId, selectedIndex, flat);

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        leadingIcon={<CommandIcon className="h-4 w-4" aria-hidden="true" />}
      >
        Commands
        <span className="ml-2 hidden rounded border border-softborder px-1.5 py-0.5 text-[11px] text-navy-soft sm:inline">
          Ctrl+K
        </span>
      </Button>

      <Modal open={open} onClose={close} labelledById={headingId} sizeClassName="max-w-xl">
        <div className="p-4 sm:p-6">
          <h2 id={headingId} className="sr-only">
            Command palette
          </h2>

          {/*
            The input suppressed its outline and replaced it with nothing, so
            there was no focus indicator anywhere (WCAG 2.4.7). Being autofocused
            when the palette opens hid the gap — tabbing back from the results
            list landed on an input that looked unfocused.

            Two changes, neither of them a ring on the input: the row is the
            visible control (the input is deliberately borderless), so the row's
            border reacts; and `focus:outline-none` is gone from the input, which
            lets the browser draw its own keyboard-only outline for free.
          */}
          <div className="flex items-center gap-2 border-b border-softborder pb-3 transition-colors focus-within:border-primary">
            <Search className="h-4 w-4 shrink-0 text-navy-soft" aria-hidden="true" />
            <label htmlFor={inputId} className="sr-only">
              Search commands
            </label>
            <input
              id={inputId}
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onKeyDown}
              maxLength={200}
              role="combobox"
              aria-expanded={flat.length > 0}
              aria-controls={`${baseId}-listbox`}
              aria-activedescendant={activeDescendant ?? undefined}
              aria-autocomplete="list"
              placeholder="Search commands…"
              className="w-full border-0 bg-transparent text-sm text-navy placeholder:text-navy-soft"
            />
            {loading && (
              <Loader2 className="h-4 w-4 shrink-0 animate-spin text-navy-soft" aria-hidden="true" />
            )}
          </div>

          {error !== null && (
            <p
              role="alert"
              className="mt-3 flex items-start gap-2 rounded-button bg-red-50 px-3 py-2 text-sm text-red-700"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              {error}
            </p>
          )}

          <ul
            id={`${baseId}-listbox`}
            role="listbox"
            aria-label="Commands"
            className="mt-3 max-h-[60vh] overflow-y-auto"
          >
            {flat.length === 0 && !loading && (
              <li className="px-2 py-6 text-center text-sm text-navy-soft">
                {emptyCommandStateText(query)}
              </li>
            )}

            {groups.map((group) => (
              <li key={group.category}>
                <p className="px-2 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-navy-soft">
                  {group.label}
                </p>
                <ul role="group" aria-label={group.label}>
                  {group.commands.map((command) => {
                    const index = flat.indexOf(command);
                    const reason = disabledReasonText(command);
                    const shortcut = shortcutLabel(command);
                    return (
                      <li
                        key={command.id}
                        id={commandOptionId(baseId, command.id)}
                        role="option"
                        aria-selected={index === selectedIndex}
                        aria-disabled={!command.enabled}
                        className={[
                          "flex items-center justify-between gap-3 rounded-button px-2 py-2 text-sm",
                          index === selectedIndex ? "bg-primary-soft" : "",
                          command.enabled ? "text-navy" : "text-navy-soft",
                        ].join(" ")}
                      >
                        <button
                          type="button"
                          // Disabled rows stay focusable and readable: the reason
                          // is the useful part. The click is refused, not hidden.
                          onClick={() => void execute(command)}
                          onMouseEnter={() => setSelectedIndex(index)}
                          disabled={!command.enabled}
                          className="flex min-w-0 flex-1 flex-col items-start text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed"
                        >
                          <span className="truncate font-medium">{command.label}</span>
                          {reason !== null && (
                            <span className="truncate text-xs text-navy-soft">{reason}</span>
                          )}
                        </button>
                        {shortcut !== null && (
                          <kbd className="shrink-0 rounded border border-softborder px-1.5 py-0.5 text-[11px] text-navy-soft">
                            {shortcut}
                          </kbd>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>

          <p role="status" aria-live="polite" className="sr-only">
            {announcement}
          </p>
        </div>
      </Modal>
    </>
  );
}
