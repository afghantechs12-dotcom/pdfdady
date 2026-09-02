import {
  ArrowUpDown,
  Briefcase,
  Building2,
  ClipboardList,
  Clock,
  Code,
  Columns2,
  Combine,
  Crop,
  Download,
  EyeOff,
  FileCheck,
  FileImage,
  FileMinus,
  FileOutput,
  FilePlus,
  FileSearch,
  FileStack,
  FileText,
  FileType,
  FileX,
  FolderKanban,
  FormInput,
  Gauge,
  GitCompare,
  Globe,
  GraduationCap,
  Hash,
  Highlighter,
  History,
  Image,
  Images,
  Languages,
  Layers,
  LayoutGrid,
  ListChecks,
  ListTree,
  Lock,
  LockOpen,
  MessageSquare,
  Minimize2,
  MessagesSquare,
  PackageCheck,
  PenLine,
  PenTool,
  Presentation,
  RotateCw,
  Save,
  ScanText,
  Scissors,
  ScrollText,
  Search,
  Sheet,
  ShieldCheck,
  ShieldOff,
  Sparkles,
  Square,
  Stamp,
  Store,
  Table2,
  Tags,
  Upload,
  Wand2,
  Wrench,
  Zap,
  type LucideProps,
} from "lucide-react";
import type { ComponentType } from "react";

/**
 * Curated icon map. Importing lucide's full `icons` namespace pulled all
 * ~1,500 icons (~420 KB) into every client bundle that renders an Icon; named
 * imports keep only these in the build. When adding a new icon name in the
 * admin panel / data files, add its import here too — unmapped names fall
 * back to a square.
 */
const iconMap: Record<string, ComponentType<LucideProps>> = {
  ArrowUpDown,
  Briefcase,
  Building2,
  ClipboardList,
  Clock,
  Code,
  Columns2,
  Combine,
  Crop,
  Download,
  EyeOff,
  FileCheck,
  FileImage,
  FileMinus,
  FileOutput,
  FilePlus,
  FileSearch,
  FileStack,
  FileText,
  FileType,
  FileX,
  FolderKanban,
  FormInput,
  Gauge,
  GitCompare,
  Globe,
  GraduationCap,
  Hash,
  Highlighter,
  History,
  Image,
  Images,
  Languages,
  Layers,
  LayoutGrid,
  ListChecks,
  ListTree,
  Lock,
  LockOpen,
  MessageSquare,
  Minimize2,
  MessagesSquare,
  PackageCheck,
  PenLine,
  PenTool,
  Presentation,
  RotateCw,
  Save,
  ScanText,
  Scissors,
  ScrollText,
  Search,
  Sheet,
  ShieldCheck,
  ShieldOff,
  Sparkles,
  Square,
  Stamp,
  Store,
  Table2,
  Tags,
  Upload,
  Wand2,
  Wrench,
  Zap,
};

interface IconProps extends LucideProps {
  name: string;
}

/**
 * Every icon name this map can resolve.
 *
 * Exported so a test can assert that the data files never name an icon the map
 * lacks. Without that assertion an unmapped name degrades silently to a blank
 * square — which is how `FolderKanban`, `History` and `Building2` shipped as
 * empty boxes on the homepage feature and use-case rows.
 */
export const ICON_NAMES: string[] = Object.keys(iconMap);

/** Whether a data-supplied icon name will render as itself. */
export function isKnownIconName(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(iconMap, name);
}

/**
 * Renders a lucide-react icon by its name string (used by data-driven
 * components like ToolCard and FeatureItem). Falls back to a square.
 */
export function Icon({ name, ...props }: IconProps) {
  const LucideIcon = iconMap[name] ?? Square;
  return <LucideIcon {...props} />;
}
