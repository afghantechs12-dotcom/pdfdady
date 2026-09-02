export interface NavLink {
  label: string;
  href: string;
  /**
   * Legacy flag meaning "open the Tools menu". Kept because `nav` is
   * admin-editable and stored entries may still carry it; `menu` supersedes it.
   */
  hasDropdown?: boolean;
  /**
   * Which resolved tool menu this item opens, if any. The key must exist in
   * `navToolMenus` — an item naming a menu that resolves to nothing renders as
   * a plain link instead, so a menu can never open onto an empty panel.
   */
  menu?: string;
  /**
   * Small label rendered beside the link (e.g. "New", "Preview").
   *
   * Used to mark work that is visible on the site but not yet usable, so the
   * nav can point at a section without implying it is a working feature.
   */
  badge?: string;
}

/**
 * The public header's primary navigation.
 *
 * Mirrors the reference design's structure — Tools, AI Assistant, Edit,
 * Convert, Compress, Pricing — with two deviations that are not cosmetic:
 *
 *  - AI Assistant is badged "Preview", not "New". Nothing behind it runs, and
 *    "New" reads as newly available.
 *  - Every item resolves to a route that exists. Edit and Convert are menu
 *    triggers whose panels are resolved against the live tool registry, and
 *    their hrefs are the tool each menu leads with, so the item still means
 *    something if the menu resolves empty.
 *
 * Deliberately absent from the reference's header: the language selector (no
 * i18n) and the theme toggle (no dark mode). Both would be controls that do
 * nothing.
 */
export const navLinks: NavLink[] = [
  { label: "Tools", href: "/tools", hasDropdown: true, menu: "tools" },
  // Points at the homepage preview section, not a tool page: the AI features
  // are not built, so there is nothing to link to that would run. The badge
  // says "Preview" rather than "New" for the same reason — "New" reads as
  // newly available.
  { label: "AI Assistant", href: "/#ai-preview", badge: "Preview" },
  { label: "Edit", href: "/tools/edit-pdf", menu: "edit" },
  { label: "Convert", href: "/tools/pdf-to-word", menu: "convert" },
  { label: "Compress", href: "/tools/compress-pdf" },
  { label: "Pricing", href: "/pricing" },
];

/**
 * The grouped tool links shown in the header's Tools dropdown.
 *
 * Slugs only — the header resolves them against the merged tool registry at
 * render time and drops anything unavailable, so a dropdown entry can never
 * outlive the tool it names or point at a tool that cannot run.
 */
export interface NavToolGroup {
  title: string;
  slugs: string[];
}

export const navToolGroups: NavToolGroup[] = [
  { title: "Edit", slugs: ["edit-pdf", "sign-pdf", "annotate-pdf", "add-watermark"] },
  { title: "Convert", slugs: ["pdf-to-word", "jpg-to-pdf", "word-to-pdf", "pdf-to-jpg"] },
  { title: "Organize", slugs: ["merge-pdf", "split-pdf", "compress-pdf", "rotate-pdf"] },
];

/**
 * Every menu the header can open, keyed by the `menu` value a nav item names.
 *
 * Each is resolved against the registry by `resolveNavToolMenus`, so a menu
 * whose tools all become unavailable disappears rather than opening onto a
 * heading over nothing.
 */
export const navToolMenus: Record<string, NavToolGroup[]> = {
  tools: navToolGroups,
  edit: [
    {
      title: "Edit a PDF",
      slugs: ["edit-pdf", "annotate-pdf", "add-watermark", "add-page-numbers"],
    },
    {
      title: "Sign & secure",
      slugs: ["sign-pdf", "fill-pdf-forms", "protect-pdf", "remove-pdf-metadata"],
    },
  ],
  convert: [
    {
      title: "PDF to",
      slugs: ["pdf-to-word", "pdf-to-jpg", "pdf-to-png", "pdf-to-pdfa"],
    },
    {
      title: "To PDF",
      slugs: ["word-to-pdf", "jpg-to-pdf", "excel-to-pdf", "powerpoint-to-pdf"],
    },
  ],
};

export interface FooterColumn {
  title: string;
  links: { label: string; href: string }[];
}

/**
 * Footer navigation.
 *
 * Six columns, matching the density of the rest of the page. Every href is a
 * route that exists: there is no newsletter signup (no endpoint, no storage),
 * no careers page and no developer API, so none is linked. "Questions?" points
 * at /contact, which is a working page.
 *
 * The column split mirrors the reference footer (Tools / Convert / Edit /
 * Product / Company / Legal) rather than the old organize-centric one, so the
 * footer reads as the same taxonomy the header's menus use.
 */
export const footerColumns: FooterColumn[] = [
  {
    title: "Tools",
    links: [
      { label: "All Tools", href: "/tools" },
      { label: "Merge PDF", href: "/tools/merge-pdf" },
      { label: "Split PDF", href: "/tools/split-pdf" },
      { label: "Organize PDF", href: "/tools/organize-pdf" },
      { label: "Compress PDF", href: "/tools/compress-pdf" },
    ],
  },
  {
    title: "Convert",
    links: [
      { label: "PDF to Word", href: "/tools/pdf-to-word" },
      { label: "PDF to JPG", href: "/tools/pdf-to-jpg" },
      { label: "Word to PDF", href: "/tools/word-to-pdf" },
      { label: "JPG to PDF", href: "/tools/jpg-to-pdf" },
      { label: "Rotate PDF", href: "/tools/rotate-pdf" },
    ],
  },
  {
    title: "Edit",
    links: [
      { label: "Edit PDF", href: "/tools/edit-pdf" },
      { label: "Sign PDF", href: "/tools/sign-pdf" },
      { label: "Annotate PDF", href: "/tools/annotate-pdf" },
      { label: "Add Watermark", href: "/tools/add-watermark" },
      { label: "Protect PDF", href: "/tools/protect-pdf" },
    ],
  },
  {
    title: "Product",
    links: [
      { label: "Workspace", href: "/workspaces" },
      { label: "Editor", href: "/editor" },
      { label: "Features", href: "/#features" },
      { label: "Pricing", href: "/pricing" },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "About", href: "/about" },
      { label: "Blog", href: "/blog" },
      { label: "Contact", href: "/contact" },
      { label: "Server Status", href: "/server-status" },
    ],
  },
  {
    title: "Legal",
    links: [
      { label: "Privacy Policy", href: "/privacy-policy" },
      { label: "Terms", href: "/terms" },
    ],
  },
];
