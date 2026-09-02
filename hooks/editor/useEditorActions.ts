"use client";

import { useMemo, useRef } from "react";
import { useEditorContext } from "@/components/editor/EditorContext";
import type { EditorActions } from "@/hooks/editor/useEditor";
import { ClipboardService } from "@/src/application/editor/clipboard/ClipboardService";
import { GroupService } from "@/src/application/editor/grouping/GroupService";
import { CompositeCommand } from "@/src/application/editor/commands/types";
import { getActivePage } from "@/src/domain/editor/document";

/**
 * High-level editor actions that compose the facade with the clipboard +
 * grouping services (copy/paste/cut/duplicate, group/ungroup, nudge, lock/hide).
 * The {@link ClipboardService} + {@link GroupService} are created once per
 * workspace and shared by the shortcut manager ({@link useShortcuts}) and the
 * context menu, so a copy here pastes there.
 */
export interface EditorActionHandlers {
  copy(): void;
  cut(): void;
  paste(): void;
  duplicate(): void;
  delete(): void;
  selectAll(): void;
  group(): void;
  ungroup(): void;
  /** Moves the selection by a delta; a shared gestureKey coalesces a held-key run into one undo entry. */
  nudge(dx: number, dy: number, gestureKey?: string): void;
  bringForward(): void;
  sendBackward(): void;
  bringToFront(): void;
  sendToBack(): void;
  toggleLock(): void;
  toggleHide(): void;
}

function runTransaction(
  label: string,
  ids: readonly string[],
  apply: (id: string) => void,
  actions: Pick<EditorActions, "beginTransaction" | "commit" | "rollback">,
): void {
  if (ids.length === 0) return;
  if (ids.length === 1) {
    apply(ids[0]);
    return;
  }
  actions.beginTransaction(label);
  try {
    ids.forEach(apply);
    actions.commit();
  } catch (error) {
    actions.rollback();
    throw error;
  }
}

export function useEditorActions(): EditorActionHandlers {
  const { state, service, selection, actions } = useEditorContext();
  const clipboardRef = useRef(new ClipboardService());
  const groupRef = useRef(new GroupService());
  const clipboard = clipboardRef.current;
  const groups = groupRef.current;

  return useMemo(
    () => ({
      copy() {
        if (selection.ids.length === 0) return;
        clipboard.copy(state, selection.ids);
      },
      cut() {
        if (selection.ids.length === 0) return;
        clipboard.copy(state, selection.ids);
        actions.deleteSelected();
      },
      paste() {
        const cmds = clipboard.pasteCommands(state);
        if (cmds.length === 0) return;
        const newIds = cmds.map((c) => (c as unknown as { object: { id: string } }).object.id);
        service.execute(new CompositeCommand("Paste", cmds));
        actions.selectMany(newIds);
      },
      duplicate() {
        if (selection.ids.length === 0) return;
        const cmds = clipboard.duplicateCommands(state, selection.ids);
        const newIds = cmds.map((c) => (c as unknown as { object: { id: string } }).object.id);
        service.execute(new CompositeCommand("Duplicate", cmds));
        actions.selectMany(newIds);
      },
      delete() {
        actions.deleteSelected();
      },
      selectAll() {
        actions.selectAll();
      },
      group() {
        if (selection.ids.length < 2) return;
        const cmd = groups.group(state, selection.ids);
        service.execute(cmd);
        actions.selectMany(groups.expandSelection(state, state.selection).ids);
      },
      ungroup() {
        if (selection.ids.length === 0) return;
        const cmd = groups.ungroup(state, selection.ids);
        service.execute(cmd);
      },
      nudge(dx, dy, gestureKey) {
        if (selection.ids.length === 0) return;
        actions.moveSelection({ x: dx, y: dy }, gestureKey);
      },
      bringForward() {
        runTransaction("Bring forward", selection.ids, actions.bringForward, actions);
      },
      sendBackward() {
        runTransaction("Send backward", selection.ids, actions.sendBackward, actions);
      },
      bringToFront() {
        runTransaction("Bring to front", selection.ids, actions.bringToFront, actions);
      },
      sendToBack() {
        runTransaction("Send to back", selection.ids, actions.sendToBack, actions);
      },
      toggleLock() {
        const page = getActivePage(state);
        const anyUnlocked = selection.ids.some((id) => !page.objects[id]?.locked);
        runTransaction(anyUnlocked ? "Lock" : "Unlock", selection.ids, (id) => {
          actions.setProperty(id, { locked: anyUnlocked }, anyUnlocked ? "Lock" : "Unlock");
        }, actions);
      },
      toggleHide() {
        const page = getActivePage(state);
        const anyVisible = selection.ids.some((id) => page.objects[id]?.visible);
        runTransaction(anyVisible ? "Hide" : "Show", selection.ids, (id) => {
          actions.setProperty(id, { visible: !anyVisible }, anyVisible ? "Hide" : "Show");
        }, actions);
      },
    }),
    [state, service, selection, actions, clipboard, groups],
  );
}
