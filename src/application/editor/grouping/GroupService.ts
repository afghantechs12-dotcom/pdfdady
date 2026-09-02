import {
  getActivePage,
  pageObjects,
  type EditorState,
} from "@/src/domain/editor/document";
import {
  getGroupId,
  setGroupId,
  type EditorObject,
} from "@/src/domain/editor/objects";
import { generateId } from "@/src/domain/editor/ids";
import { SetPropertyCommand } from "@/src/application/editor/commands/commands";
import {
  CompositeCommand,
  type Command,
} from "@/src/application/editor/commands/types";

/**
 * Grouping for the PDFDadi editor (Part 9).
 *
 * A group is expressed through `metadata.groupId` (see {@link getGroupId} /
 * {@link setGroupId}) rather than a dedicated field, so the core object model
 * and serialization shape stay stable. This service turns group/ungroup intents
 * into undoable commands: {@link group} writes one fresh groupId onto every
 * given object, {@link ungroup} clears it. Both return a {@link CompositeCommand}
 * so a single undo restores the prior membership. Selection expansion
 * ({@link groupMembers}, {@link expandSelection}) lets the UI treat a group as
 * one unit: picking any member selects them all.
 */
export class GroupService {
  /**
   * Returns a {@link CompositeCommand} that stamps one fresh groupId onto every
   * object named by `ids` (looked up on the active page). Requires at least two
   * ids — a group of one has no behavioral meaning — and throws otherwise. The
   * composite's invert clears the groupId, restoring the prior metadata.
   */
  group(state: EditorState, ids: string[]): Command {
    if (ids.length < 2) {
      throw new Error("Group requires at least two objects.");
    }
    const page = getActivePage(state);
    const wanted = new Set(ids);
    const groupId = generateId("group");
    const commands = pageObjects(page)
      .filter((obj) => wanted.has(obj.id))
      .map(
        (obj) =>
          new SetPropertyCommand(
            "Group",
            obj.id,
            { metadata: obj.metadata },
            { metadata: setGroupId(obj, groupId).metadata },
          ),
      );
    return new CompositeCommand("Group", commands);
  }

  /**
   * Returns a {@link CompositeCommand} that clears the groupId on every object
   * that shares a group with any of the given ids (including the ids
   * themselves). Throws when none of the given ids are part of a group. The
   * composite's invert re-stamps the original groupId, restoring membership.
   */
  ungroup(state: EditorState, ids: string[]): Command {
    const members = this.groupMembers(state, ids);
    if (members.length === 0) {
      throw new Error("No group to ungroup.");
    }
    const page = getActivePage(state);
    const byId = new Map<string, EditorObject>(
      pageObjects(page).map((obj) => [obj.id, obj]),
    );
    const commands = members.map(
      (id) => {
        const obj = byId.get(id)!;
        return new SetPropertyCommand(
          "Ungroup",
          id,
          { metadata: obj.metadata },
          { metadata: setGroupId(obj, null).metadata },
        );
      },
    );
    return new CompositeCommand("Ungroup", commands);
  }

  /**
   * All object ids on the active page that share a group with any of the given
   * ids (including the ids themselves), in paint order. Returns `[]` when none
   * of the given ids carry a groupId.
   */
  groupMembers(state: EditorState, ids: string[]): string[] {
    const page = getActivePage(state);
    const objects = pageObjects(page);
    const wanted = new Set(ids);
    const groupIds = new Set(
      objects
        .filter((obj) => wanted.has(obj.id))
        .map((obj) => getGroupId(obj))
        .filter((g): g is string => g !== null),
    );
    if (groupIds.size === 0) return [];
    return objects
      .filter((obj) => {
        const g = getGroupId(obj);
        return g !== null && groupIds.has(g);
      })
      .map((obj) => obj.id);
  }

  /**
   * Expands a selection to include every group member of any selected object.
   * The union dedupes preserving the original order (selection ids first, then
   * any newly discovered members). `primaryId` is kept when it survives the
   * union; otherwise it falls back to the last id (the selection's natural
   * anchor).
   */
  expandSelection(
    state: EditorState,
    selection: { ids: string[]; primaryId: string | null },
  ): { ids: string[]; primaryId: string | null } {
    const members = this.groupMembers(state, selection.ids);
    const merged: string[] = [];
    const seen = new Set<string>();
    for (const id of [...selection.ids, ...members]) {
      if (!seen.has(id)) {
        seen.add(id);
        merged.push(id);
      }
    }
    let primaryId = selection.primaryId;
    if (primaryId === null || !seen.has(primaryId)) {
      primaryId = merged.length > 0 ? merged[merged.length - 1] : null;
    }
    return { ids: merged, primaryId };
  }
}
