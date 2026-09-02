/**
 * Shared "is the user typing?" predicate (M6). The shortcut manager and the
 * canvas's capture-phase key handlers (crop, pen) MUST agree on this — two
 * divergent copies is how one handler hijacks keys the other releases.
 *
 * Checkbox/radio/range inputs are NOT text inputs (arrow keys there are
 * value-editing, but single-letter tool keys are safe); everything that takes
 * typed text is, including custom fields marked `data-editor-text-input`.
 */
export function isTextInput(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  if (el.tagName === "INPUT") {
    const type = (el as HTMLInputElement).type;
    return type !== "checkbox" && type !== "radio" && type !== "range";
  }
  if (el.tagName === "TEXTAREA") return true;
  if (el.isContentEditable) return true;
  if (el.hasAttribute?.("data-editor-text-input")) return true;
  return false;
}

/**
 * True for any interactive control (button/select/link/input/…): keys pressed
 * while one of these is focused belong to that control, so modal key handlers
 * (crop Enter/arrows) must not steal them (M6 a11y review A11Y-9).
 */
export function isInteractiveElement(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  if (isTextInput(el)) return true;
  const tag = el.tagName;
  return tag === "BUTTON" || tag === "SELECT" || tag === "A" || tag === "OPTION" || tag === "INPUT";
}
