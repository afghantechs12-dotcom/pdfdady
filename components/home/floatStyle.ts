/**
 * The two custom properties a floating decorative element sets.
 *
 * `CSSProperties` has no index signature, so a literal containing `--*` keys is
 * rejected outright. Declaring them here keeps the call sites type-checked —
 * a typo in either name is still an error — where a blanket cast would not.
 */
export type FloatStyle = React.CSSProperties &
  Partial<Record<"--float-delay" | "--float-rotate", string>>;

/**
 * Builds the style for one floating element.
 *
 * `transform` carries the resting rotation and the `float-drift` keyframes in
 * globals.css re-declare it via `--float-rotate`, so the element keeps its angle
 * while drifting instead of snapping upright the moment the animation starts.
 *
 * Shared by every homepage illustration that floats something (the hero's format
 * cards and dock, the Workspace folder art), because each of them needs the same
 * `--*`-typing workaround and duplicating it invites one copy to drift.
 */
export function floatStyle(delay: string, rotate: string): FloatStyle {
  return {
    "--float-delay": delay,
    "--float-rotate": rotate,
    transform: `rotate(${rotate})`,
  };
}
