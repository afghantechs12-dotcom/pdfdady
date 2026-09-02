import {
  Circle,
  CircleDot,
  Crop,
  Eraser,
  Hand,
  Highlighter,
  Image as ImageIcon,
  MessageCircle,
  MessageSquare,
  Minus,
  MousePointer2,
  MoveUpRight,
  Pen,
  PenTool,
  Pentagon,
  Signature,
  Square,
  Squircle,
  Star,
  Triangle,
  Type,
  Waypoints,
  type LucideIcon,
} from "lucide-react";

/**
 * The ONE place toolbar icon ids resolve to icon components (M6.12). The
 * canonical tool table (`toolbarLayout.ts`) stays renderer-agnostic by naming
 * icons with string ids; this registry maps each id to its Lucide component.
 * A test asserts every tool's icon id has an entry, so a new tool can't ship
 * with a missing icon.
 */
export const TOOLBAR_ICONS: Readonly<Record<string, LucideIcon>> = {
  select: MousePointer2,
  hand: Hand,
  text: Type,
  image: ImageIcon,
  signature: Signature,
  annotation: MessageSquare,
  rect: Square,
  roundedRect: Squircle,
  ellipse: Circle,
  circle: CircleDot,
  triangle: Triangle,
  line: Minus,
  arrow: MoveUpRight,
  polygon: Pentagon,
  star: Star,
  speechBubble: MessageCircle,
  connector: Waypoints,
  draw: Pen,
  highlight: Highlighter,
  eraser: Eraser,
  path: PenTool,
  crop: Crop,
};

/** The icon component for an icon id, or null when unregistered. */
export function toolIcon(iconId: string): LucideIcon | null {
  // Object.hasOwn: a prototype-named id ("constructor", "toString") must not
  // leak an Object.prototype member out as a "component".
  return Object.hasOwn(TOOLBAR_ICONS, iconId) ? TOOLBAR_ICONS[iconId] : null;
}
