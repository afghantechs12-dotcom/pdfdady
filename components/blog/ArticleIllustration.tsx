import {
  ILLUSTRATION_VIEWBOX,
  illustrationToneClasses,
  type IllustrationId,
} from "@/components/blog/articleIllustrations";
import type { IconTone } from "@/styles/tokens";
import { cn } from "@/lib/utils/cn";

/**
 * Renders the workflow diagram for a blog article. Pure inline SVG, driven by
 * `currentColor` so the tone classes from `articleIllustrations` apply.
 *
 * Each diagram uses the same visual vocabulary:
 *   - document sheets are rounded rects with a folded corner;
 *   - a small arrow path marks the flow (inputs → output);
 *   - `strong` is the subject, `soft` the supporting sheets.
 */

/** A document sheet with a dog-eared corner. */
function Sheet({
  x,
  y,
  w = 26,
  h = 34,
  fold = true,
  className,
}: {
  x: number;
  y: number;
  w?: number;
  h?: number;
  fold?: boolean;
  className?: string;
}) {
  const r = 3.5;
  return (
    <g className={className}>
      <rect x={x} y={y} width={w} height={h} rx={r} fill="currentColor" />
      {fold ? (
        <path d={`M${x + w - 9} ${y}h7l-7 7z`} fill="rgba(255,255,255,0.4)" />
      ) : null}
    </g>
  );
}

/** A page turned sideways, to show rotation. */
function SheetRotated({ x, y }: { x: number; y: number }) {
  return (
    <g className="text-current">
      <rect x={x} y={y} width={34} height={26} rx={3.5} fill="currentColor" />
      <path d={`M${x + 12} ${y + 9}l10 0l0 10l-10 0z`} fill="rgba(255,255,255,0.45)" />
    </g>
  );
}

/** The small flow arrow between steps. */
function Flow({ x1, x2, y = 48 }: { x1: number; x2: number; y?: number }) {
  return (
    <path
      d={`M${x1} ${y}h${x2 - x1 - 6}m${-4} 0l4 3m-4 -3l4 -3`}
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
      className="opacity-60"
    />
  );
}

/** Two sheets becoming one. */
function MergeDiagram() {
  return (
    <>
      <Sheet x={34} y={26} className="opacity-50" />
      <Sheet x={50} y={38} className="opacity-50" />
      <Flow x1={76} x2={108} />
      <Sheet x={114} y={30} w={30} h={38} className="opacity-100" />
      <path d="M129 44l6 6m-6-6l-6 6" stroke="currentColor" strokeWidth={2} opacity={0.6} />
    </>
  );
}

/** A large sheet shrinking to a small one. */
function CompressDiagram() {
  return (
    <>
      <Sheet x={40} y={22} w={34} h={44} className="opacity-50" />
      <Flow x1={88} x2={112} />
      <Sheet x={118} y={32} w={24} h={32} className="opacity-100" />
      <path d="M122 48l14 14m-14-14l14-14" stroke="currentColor" strokeWidth={2} opacity={0.6} />
    </>
  );
}

/** A sheet growing a lock. */
function ProtectDiagram() {
  return (
    <>
      <Sheet x={44} y={30} className="opacity-50" />
      <Flow x1={76} x2={104} />
      <Sheet x={110} y={26} w={28} h={36} className="opacity-100" />
      <g opacity={0.85}>
        <rect x={119} y={38} width={10} height={8} rx={1.5} fill="currentColor" />
        <path d="M121 38v-3a3 3 0 0 1 6 0v3" stroke="currentColor" strokeWidth={1.8} fill="none" />
      </g>
    </>
  );
}

/** One multi-page sheet becoming two. */
function SplitDiagram() {
  return (
    <>
      <Sheet x={40} y={22} w={34} h={44} className="opacity-50" />
      <path d="M57 24v40" stroke="rgba(255,255,255,0.5)" strokeWidth={1.5} />
      <Flow x1={88} x2={112} />
      <Sheet x={118} y={22} className="opacity-90" />
      <Sheet x={140} y={40} className="opacity-70" />
    </>
  );
}

/** An image sheet becoming a document sheet. */
function ConvertDiagram() {
  return (
    <>
      <g className="opacity-50">
        <rect x={34} y={28} width={32} height={34} rx={3.5} fill="currentColor" />
        <circle cx={46} cy={40} r={4} fill="rgba(255,255,255,0.55)" />
        <path d="M38 54l8-8 6 6 6-6" stroke="rgba(255,255,255,0.55)" strokeWidth={2} fill="none" />
      </g>
      <Flow x1={76} x2={104} />
      <Sheet x={112} y={28} w={30} h={36} className="opacity-100" />
    </>
  );
}

/** A sheet gaining an edit cursor + text lines. */
function EditDiagram() {
  return (
    <>
      <Sheet x={38} y={24} w={36} h={44} className="opacity-50" />
      <Flow x1={86} x2={106} />
      <Sheet x={112} y={26} w={34} h={40} className="opacity-100" />
      <g stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" opacity={0.7}>
        <path d="M120 40h18" />
        <path d="M120 46h18" />
        <path d="M120 52h10" />
      </g>
    </>
  );
}

/** A sheet flipping 90°, with an arc arrow. */
function RotateDiagram() {
  return (
    <>
      <Sheet x={38} y={32} className="opacity-50" />
      <path
        d="M70 48h18m0 0l-5-5m5 5l-5 5"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        fill="none"
        className="opacity-60"
      />
      <SheetRotated x={104} y={34} />
    </>
  );
}

/** A sheet gaining a "#" line. */
function PaginateDiagram() {
  return (
    <>
      <Sheet x={40} y={24} w={34} h={44} className="opacity-50" />
      <Flow x1={86} x2={106} />
      <Sheet x={112} y={26} w={34} h={40} className="opacity-100" />
      <g stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" opacity={0.7}>
        <path d="M122 34l-3 14" />
        <path d="M132 34l-3 14" />
        <path d="M118 40h14" />
        <path d="M120 46h14" />
      </g>
    </>
  );
}

/** A sheet with a crop frame on its corner. */
function CropDiagram() {
  return (
    <>
      <Sheet x={56} y={22} w={40} h={48} className="opacity-100" />
      <path
        d="M60 56v-8m0 8h8m16-8v-24m-16 24h16"
        stroke="currentColor"
        strokeWidth={2.4}
        strokeLinecap="round"
        fill="none"
        opacity={0.8}
      />
    </>
  );
}

/** A single document sheet: the fallback for an unrecognised icon. */
function GenericDiagram() {
  return <Sheet x={84} y={30} className="opacity-90" />;
}

const DIAGRAMS: Record<IllustrationId, () => React.ReactNode> = {
  merge: MergeDiagram,
  compress: CompressDiagram,
  protect: ProtectDiagram,
  split: SplitDiagram,
  convert: ConvertDiagram,
  edit: EditDiagram,
  rotate: RotateDiagram,
  paginate: PaginateDiagram,
  crop: CropDiagram,
  generic: GenericDiagram,
};

export function ArticleIllustration({
  id,
  tone,
  className,
}: {
  id: IllustrationId;
  tone: IconTone;
  className?: string;
}) {
  const Diagram = DIAGRAMS[id];
  const { strong } = illustrationToneClasses[tone];
  return (
    <svg
      viewBox={ILLUSTRATION_VIEWBOX}
      role="presentation"
      aria-hidden="true"
      focusable="false"
      // The root carries the `strong` tone; depth comes from per-element
      // opacity inside each diagram, so `currentColor` stays a single hue and
      // the two depths cannot drift into two different colours.
      className={cn("h-24 w-full", strong, className)}
    >
      <Diagram />
    </svg>
  );
}
