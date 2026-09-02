import { beforeEach, describe, expect, it } from "vitest";
import {
  addObjectToPage,
  createEditorState,
  getActivePage,
  getObject,
  type EditorState,
} from "@/src/domain/editor/document";
import { getGroupId } from "@/src/domain/editor/objects";
import { makeRect, resetFactory } from "@/src/domain/editor/testFactories";
import { GroupService } from "./GroupService";

/** A fresh state with `count` rect objects on the default page, in paint order. */
function stateWithRects(count: number): EditorState {
  const initial = createEditorState();
  let page = getActivePage(initial);
  for (let i = 0; i < count; i++) page = addObjectToPage(page, makeRect());
  return { ...initial, document: { ...initial.document, pages: [page] } };
}

describe("GroupService", () => {
  beforeEach(() => resetFactory());

  it("group sets a shared groupId on all given objects", () => {
    const state = stateWithRects(3);
    const ids = Object.keys(getActivePage(state).objects);
    const cmd = new GroupService().group(state, ids);

    const grouped = cmd.apply(state);
    const groupIds = ids.map(
      (id) => getGroupId(getObject(getActivePage(grouped), id)!)!,
    );
    expect(groupIds.every((g) => g !== null)).toBe(true);
    expect(new Set(groupIds).size).toBe(1);
  });

  it("ungroup clears the groupId on all members", () => {
    const state = stateWithRects(3);
    const ids = Object.keys(getActivePage(state).objects);
    const svc = new GroupService();
    const grouped = svc.group(state, ids).apply(state);

    const ungrouped = svc.ungroup(grouped, ids).apply(grouped);
    for (const id of ids) {
      expect(getGroupId(getObject(getActivePage(ungrouped), id)!)).toBeNull();
    }
  });

  it("groupMembers returns every member of a group, in paint order", () => {
    const state = stateWithRects(3);
    const ids = Object.keys(getActivePage(state).objects);
    const svc = new GroupService();
    const grouped = svc.group(state, ids).apply(state);

    const members = svc.groupMembers(grouped, [ids[0]]);
    expect(members).toEqual(ids);
  });

  it("groupMembers returns [] when the ids carry no group", () => {
    const state = stateWithRects(3);
    const ids = Object.keys(getActivePage(state).objects);
    expect(new GroupService().groupMembers(state, ids)).toEqual([]);
  });

  it("expandSelection adds all group members to the selection", () => {
    const state = stateWithRects(3);
    const ids = Object.keys(getActivePage(state).objects);
    const svc = new GroupService();
    const grouped = svc.group(state, ids).apply(state);

    // Selecting only the first member should pull in the whole group.
    const expanded = svc.expandSelection(grouped, {
      ids: [ids[0]],
      primaryId: ids[0],
    });
    expect(expanded.ids).toEqual(ids);
    expect(expanded.primaryId).toBe(ids[0]);
  });

  it("expandSelection preserves order, dedupes, and keeps a still-present primary", () => {
    const state = stateWithRects(3);
    const ids = Object.keys(getActivePage(state).objects);
    const svc = new GroupService();
    const grouped = svc.group(state, ids).apply(state);

    // Start with two of the three already selected; expansion adds the third
    // without duplicating the first two, and the primary is retained.
    const expanded = svc.expandSelection(grouped, {
      ids: [ids[1], ids[0]],
      primaryId: ids[1],
    });
    expect(expanded.ids).toEqual([ids[1], ids[0], ids[2]]);
    expect(expanded.primaryId).toBe(ids[1]);
  });

  it("expandSelection falls back to the last id when the primary is gone", () => {
    const state = stateWithRects(2);
    const ids = Object.keys(getActivePage(state).objects);
    const svc = new GroupService();
    const grouped = svc.group(state, ids).apply(state);

    const expanded = svc.expandSelection(grouped, {
      ids: [ids[0]],
      primaryId: "not-in-selection",
    });
    expect(expanded.primaryId).toBe(ids[ids.length - 1]);
  });

  it("group with fewer than two ids throws", () => {
    const state = stateWithRects(3);
    const ids = Object.keys(getActivePage(state).objects);
    const svc = new GroupService();
    expect(() => svc.group(state, [ids[0]])).toThrow(
      "Group requires at least two objects.",
    );
    expect(() => svc.group(state, [])).toThrow(
      "Group requires at least two objects.",
    );
  });

  it("ungroup with no group throws", () => {
    const state = stateWithRects(3);
    const ids = Object.keys(getActivePage(state).objects);
    const svc = new GroupService();
    expect(() => svc.ungroup(state, ids)).toThrow("No group to ungroup.");
  });

  it("group and ungroup are inverses via apply/invert (metadata restored)", () => {
    const state = stateWithRects(3);
    const ids = Object.keys(getActivePage(state).objects);
    // Snapshot the original metadata so the invert assertion is exact.
    const originalMetadata = ids.map(
      (id) => getObject(getActivePage(state), id)!.metadata,
    );
    const svc = new GroupService();

    const groupCmd = svc.group(state, ids);
    const grouped = groupCmd.apply(state);
    for (const id of ids) {
      expect(getGroupId(getObject(getActivePage(grouped), id)!)).not.toBeNull();
    }

    // Inverting the group command restores the original metadata exactly.
    const undone = groupCmd.invert(grouped);
    for (let i = 0; i < ids.length; i++) {
      const obj = getObject(getActivePage(undone), ids[i])!;
      expect(getGroupId(obj)).toBeNull();
      expect(obj.metadata).toEqual(originalMetadata[i]);
    }
  });

  it("ungroup's invert re-stamps the original groupId", () => {
    const state = stateWithRects(3);
    const ids = Object.keys(getActivePage(state).objects);
    const svc = new GroupService();
    const grouped = svc.group(state, ids).apply(state);
    const stampedGroup = getGroupId(getObject(getActivePage(grouped), ids[0])!)!;

    const ungroupCmd = svc.ungroup(grouped, ids);
    const ungrouped = ungroupCmd.apply(grouped);
    for (const id of ids) {
      expect(getGroupId(getObject(getActivePage(ungrouped), id)!)).toBeNull();
    }

    // Inverting ungroup re-applies the same groupId to every member.
    const redone = ungroupCmd.invert(ungrouped);
    for (const id of ids) {
      expect(getGroupId(getObject(getActivePage(redone), id)!)).toBe(stampedGroup);
    }
  });

  it("ungroup clears every object sharing the group, not just the named ids", () => {
    const state = stateWithRects(3);
    const ids = Object.keys(getActivePage(state).objects);
    const svc = new GroupService();
    const grouped = svc.group(state, ids).apply(state);

    // Name only one id; all three members must be ungrouped.
    const ungrouped = svc.ungroup(grouped, [ids[1]]).apply(grouped);
    for (const id of ids) {
      expect(getGroupId(getObject(getActivePage(ungrouped), id)!)).toBeNull();
    }
  });
});
