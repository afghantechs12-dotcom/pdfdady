import { Command } from './types';
import { TextFrame } from '@/src/domain/editor/textContent';
import { TextObject } from '@/src/domain/editor/objects';
import { getActivePage, getObject, setActivePage, setObject } from '@/src/domain/editor/document';

/**
 * Command to set text frame for a text object
 * This is a pure immutable command that updates the frame without modifying localBounds
 */
export class SetTextFrameCommand implements Command {
  readonly type = 'SetTextFrame';

  constructor(
    public readonly objectId: string,
    public readonly before: TextFrame,
    public readonly after: TextFrame
  ) {}

  /**
   * Applies the command to update text frame
   * @param state The editor state
   * @returns The updated editor state
   */
  apply(state: any): any {
    const page = getActivePage(state);
    const obj = getObject(page, this.objectId);

    // Type assertion to avoid complex typing issues
    const textObj = obj as TextObject;

    // Make sure this is a text object
    if (!textObj || textObj.kind !== 'text') {
      return state;
    }

    // Create a deep copy of the object to avoid mutation
    const updatedObject = { ...textObj };

    // Update the frame - no localBounds synchronization
    updatedObject.frame = this.after;

    // Update the page with the modified object
    const updatedPage = setObject(page, updatedObject);
    return setActivePage(state, updatedPage);
  }

  /**
   * Gets the affected object IDs for cache invalidation
   * @returns Array of affected object IDs
   */
  getAffectedObjectIds(): string[] {
    return [this.objectId];
  }

  /**
   * Label for the command (used in undo/redo menus)
   */
  get label(): string {
    return "Change text frame";
  }

  /**
   * Inverts the command to undo the change
   * @param state The editor state
   * @returns The editor state after undo
   */
  invert(state: any): any {
    const page = getActivePage(state);
    const obj = getObject(page, this.objectId);

    // Type assertion to avoid complex typing issues
    const textObj = obj as TextObject;

    // Make sure this is a text object
    if (!textObj || textObj.kind !== 'text') {
      return state;
    }

    // Create a deep copy of the object to avoid mutation
    const updatedObject = { ...textObj };

    // Revert the frame
    updatedObject.frame = this.before;

    // Update the page with the modified object
    const updatedPage = setObject(page, updatedObject);
    return setActivePage(state, updatedPage);
  }
}