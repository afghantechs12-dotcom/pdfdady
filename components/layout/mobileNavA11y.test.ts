import { readFileSync } from "node:fs";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * U4 — mobile navigation is keyboard accessible.
 *
 * Both drawers open from state an event sets, and `useEffect` does not run
 * under SSR, so what this file can prove is the CLOSED contract and the trigger
 * that opens it. That is not a consolation prize: the recorded regression in
 * both components was a drawer that stayed mounted and was collapsed with
 * `max-height`, leaving every link in the tab order while invisible — a
 * keyboard user tabbed into nothing. A closed render is exactly where that
 * shows up.
 *
 * The open drawer's focus trap is proven twice elsewhere, and deliberately not
 * re-asserted here: `lib/a11y/focusTrap.test.ts` covers the wrap arithmetic,
 * and scenario F5 of the Phase 6 browser probe tabs through the real open
 * drawer and checks that Escape returns focus to the trigger.
 */

vi.mock("next/navigation", () => ({
  usePathname: () => "/tools",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: () => {}, replace: () => {} }),
}));

const NAV = [
  { label: "Tools", href: "/tools", menu: "tools" },
  { label: "Pricing", href: "/pricing" },
];
const MENUS = {
  tools: [{ title: "Organise", tools: [{ slug: "merge-pdf", name: "Merge PDF", href: "/tools/merge-pdf" }] }],
};

const publicHeader = async () => {
  const { Header } = await import("./Header");
  return renderToStaticMarkup(h(Header, { navLinks: NAV, toolMenus: MENUS, availableCount: 32 }));
};

const appShell = async () => {
  const { AppShell } = await import("@/components/app/AppShell");
  return renderToStaticMarkup(
    h(AppShell, {
      workspaces: [{ id: "w1", name: "Acme", lifecycleState: "active" }],
      workspaceId: "w1",
      organizationId: "o1",
      user: { name: "Ada", email: "ada@example.com" },
      children: h("p", null, "content"),
    }),
  );
};

/** The attributes of the element whose `aria-label` matches. */
const tagWithLabel = (html: string, label: string) =>
  new RegExp(`<[a-z]+[^>]*aria-label="${label}"[^>]*>`).exec(html)?.[0] ?? "";

describe("U4 — mobile navigation is keyboard accessible", () => {
  it("mounts no drawer at all until it is opened", async () => {
    for (const html of [await publicHeader(), await appShell()]) {
      // Not hidden, not zero-height: absent. A collapsed-but-mounted drawer is
      // the regression both components' docblocks record.
      expect(html).not.toContain('aria-modal="true"');
      expect(html).not.toContain('role="dialog"');
      expect(html).not.toMatch(/max-h-0|h-0 overflow-hidden/);
    }
  });

  it("gives the public header trigger a name, a state and a target", async () => {
    const html = await publicHeader();
    const trigger = tagWithLabel(html, "Open menu");
    expect(trigger).toContain('aria-expanded="false"');
    expect(trigger).toContain('aria-controls="mobile-menu"');
    // 44px, so the trigger itself satisfies 2.5.8 on a phone.
    expect(trigger).toMatch(/\bh-11\b/);
    expect(trigger).toMatch(/\bw-11\b/);
    expect(trigger).toContain("focus-visible:ring-2");
  });

  it("gives the app shell trigger the same contract", async () => {
    const html = await appShell();
    const trigger = tagWithLabel(html, "Open navigation");
    expect(trigger).toContain('aria-expanded="false"');
    expect(trigger).toMatch(/\bh-10\b/);
    expect(trigger).toMatch(/\bw-10\b/);
    expect(trigger).toContain("focus-visible:ring-2");
    // Hidden once the persistent rail appears, so the two never both offer
    // navigation and a desktop tab order never passes through a dead control.
    expect(trigger).toContain("lg:hidden");
  });

  it("keeps the desktop rail out of the narrow-viewport tab order", async () => {
    const html = await appShell();
    // `hidden` (display:none) and not `opacity-0`/`-translate-x-full`: a
    // translated-off-screen rail stays focusable, and tabbing lands the user
    // somewhere they cannot see.
    expect(html).toMatch(/class="sticky top-0 hidden h-screen shrink-0 lg:block"/);
  });

  it("wires both drawers to the shared focus trap, keyed on the open flag", () => {
    // Source guards. The trap's own behaviour is unit-tested; what cannot be
    // rendered here is that these two call sites pass the flag and a closer.
    const header = readFileSync("components/layout/Header.tsx", "utf8");
    const shell = readFileSync("components/app/AppShell.tsx", "utf8");
    expect(header).toContain("useFocusTrap(drawerRef, open, () => setOpen(false))");
    expect(shell).toContain("useFocusTrap(drawerRef, mobileOpen, () => setMobileOpen(false))");
    // Focus must not be dropped at the top of the document when it closes.
    // The trap itself restores it, which is why neither drawer does so by hand
    // (the app shell adds a belt-and-braces effect on the same element).
    const trap = readFileSync("lib/a11y/focusTrap.ts", "utf8");
    expect(trap).toContain("previouslyFocused.current = document.activeElement");
    expect(trap).toMatch(/if \(prev && typeof prev\.focus === "function"\) prev\.focus\(\);/);
    expect(shell).toMatch(/if \(!mobileOpen\) menuButtonRef\.current\?\.focus/);
  });

  it("keeps every drawer row at a thumb-sized height", async () => {
    // The rows themselves render only when open, so this is the source. The
    // rendered proof is probe scenario F.
    const header = readFileSync("components/layout/Header.tsx", "utf8");
    const drawer = header.slice(header.indexOf('id="mobile-menu"'));
    expect(drawer).toContain("min-h-[44px]");
    // Native `<details>` groups, so expanding a group needs no JS and no
    // custom keyboard handling.
    expect(drawer).toContain("<details");
  });

  it("scrolls a tall drawer instead of clipping it", async () => {
    const header = readFileSync("components/layout/Header.tsx", "utf8");
    const drawer = header.slice(header.indexOf('id="mobile-menu"'));
    // `dvh`, not `vh`: on iOS the toolbar overlays a `vh`-sized panel and the
    // last row cannot be reached.
    expect(drawer).toMatch(/max-h-\[calc\(100dvh-\d+px\)\]/);
    expect(drawer).toContain("overflow-y-auto");
  });
});
