/** Organization (tenant) domain entity. */
export interface Organization {
  id: string;
  name: string;
  slug: string;
  /** "free" | "pro" | "ai" | "business" — maps to the pricing tiers. */
  plan: string;
  defaultWorkspaceId: string | null;
  createdAt: Date;
}
