/**
 * Welcome packs (TASK welcome-packs) — shared DTO shapes.
 *
 * Deliberately mode-free: unlike tournaments, a Welcome element carries exactly
 * ONE prompt, so there is no `mode`, no `nameVip` and no Base/VIP anywhere.
 */

export interface WelPromptInfo {
  content: string;
  updatedAt: string;
}

export interface WelOverrideInfo {
  content: string;
  /** The global default moved after this override was saved/acknowledged. */
  defaultChanged: boolean;
}

export interface WelElement {
  id: string;
  name: string;
  order: number;
  /** Used only while the category has usesOwnReferences=true. */
  referenceImages: string[];
  /** null while nobody has written a default prompt for this element yet. */
  prompt: WelPromptInfo | null;
  override: WelOverrideInfo | null;
}

export interface WelCategory {
  id: string;
  key: string;
  name: string;
  /** Elements bring their own reference images instead of the brand's. */
  usesOwnReferences: boolean;
  order: number;
  elements: WelElement[];
}

export type WelAspect = "1:1" | "9:16";
