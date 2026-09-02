import { Command } from './types';
import { TextContent } from '@/src/domain/editor/textContent';
import { TextObject } from '@/src/domain/editor/objects';
import { getActivePage, getObject, setActivePage, setObject } from '@/src/domain/editor/document';

/**
 * Command to set text content for a text object
 * This is a pure immutable command that updates both content (canonical) and text (legacy scalar)
 */
export class SetTextContentCommand implements Command {
  readonly type = 'SetTextContent';

  constructor(
    public readonly objectId: string,
    public readonly paragraphIndex: number,
    public readonly runIndex: number,
    public readonly before: string,
    public readonly after: string
  ) {}

  /**
   * Applies the command to update text content
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

    // Update the content - modify the specific run text
    if (updatedObject.content &&
        updatedObject.content.paragraphs &&
        updatedObject.content.paragraphs[this.paragraphIndex] &&
        updatedObject.content.paragraphs[this.paragraphIndex].runs &&
        updatedObject.content.paragraphs[this.paragraphIndex].runs[this.runIndex]) {

      // Update the text in the specific run
      updatedObject.content.paragraphs[this.paragraphIndex].runs[this.runIndex].text = this.after;

      // Rebuild the legacy text field from updated content for compatibility
      updatedObject.text = this.rebuildLegacyText(updatedObject.content);
    }

    // Update the page with the modified object
    const updatedPage = setObject(page, updatedObject);
    return setActivePage(state, updatedPage);
  }

  /**
   * Rebuilds the legacy text field from canonical content
   * Compatibility projection: rebuild legacy scalar from canonical content
   * @param content The canonical text content
   * @returns The concatenated text string
   */
  private rebuildLegacyText(content: TextContent): string {
    if (!content || !content.paragraphs) {
      return '';
    }

    const paragraphs: string[] = [];

    for (const paragraph of content.paragraphs) {
      if (paragraph && paragraph.runs) {
        const runs = paragraph.runs.map((run: any) => run.text || '').join('');
        paragraphs.push(runs);
      }
    }

    return paragraphs.join('\n');
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
    return "Change text content";
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

    // Revert the content - modify the specific run text back
    if (updatedObject.content &&
        updatedObject.content.paragraphs &&
        updatedObject.content.paragraphs[this.paragraphIndex] &&
        updatedObject.content.paragraphs[this.paragraphIndex].runs &&
        updatedObject.content.paragraphs[this.paragraphIndex].runs[this.runIndex]) {

      // Revert the text in the specific run
      updatedObject.content.paragraphs[this.paragraphIndex].runs[this.runIndex].text = this.before;

      // Rebuild the legacy text field from reverted content for compatibility
      updatedObject.text = this.rebuildLegacyText(updatedObject.content);
    }

    // Update the page with the modified object
    const updatedPage = setObject(page, updatedObject);
    return setActivePage(state, updatedPage);
  }
}