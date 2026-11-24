/**
 * Media catalog: the media types a board can be made of, the installation methods, and the site questions asked per board.
 * One master for web and phone. The phone keeps a built-in copy only as an offline fallback.
 */

/** Icon names the admin screens offer (the phone and the web each map a name to their own icon; an unknown name shows a plain default). */
export const CATALOG_ICONS = [
  'lightbulb_outline', 'crop_landscape', 'crop_square', 'rectangle_outlined', 'layers_outlined', 'text_fields', 'text_rotation_none', 'flip', 'flag_outlined',
  'blur_on', 'change_history', 'window_outlined', 'door_sliding_outlined', 'storefront_outlined', 'wallpaper', 'wallpaper_outlined', 'format_paint_outlined',
  'signpost_outlined', 'roofing_outlined', 'open_in_full', 'view_week_outlined', 'view_quilt_outlined', 'view_column_outlined', 'view_agenda', 'view_agenda_outlined',
  'handyman_outlined', 'construction', 'straighten', 'inventory_2_outlined', 'category_outlined', 'light_mode_outlined', 'architecture',
] as const;
export type CatalogIcon = (typeof CATALOG_ICONS)[number];

export const SIDEDNESS = ['SINGLE', 'DOUBLE', 'SELECTABLE'] as const;
export type Sidedness = (typeof SIDEDNESS)[number];

export const QUESTION_TYPES = ['TEXT', 'NUMBER', 'YES_NO', 'CHOICE'] as const;
export type QuestionKind = (typeof QUESTION_TYPES)[number];

/** COMMON: asked for every board. MEDIA: only for one media type. INSTALLATION: only for one installation method. */
export const QUESTION_SCOPES = ['COMMON', 'MEDIA', 'INSTALLATION'] as const;
export type QuestionScope = (typeof QUESTION_SCOPES)[number];

export type SeedMedia = {
  code: string; shortName: string; name: string; description: string; icon: CatalogIcon; color: string; illuminated: boolean; sidedness: Sidedness;
  depthFt: number; thicknessMm: number; template: string; installations: string[]; legacy: boolean; order: number;
};
export type SeedInstallation = { code: string; name: string; description: string; icon: CatalogIcon; order: number };
export type SeedQuestion = {
  scope: QuestionScope; scopeCode?: string; id: string; label: string; type: QuestionKind; options: string[]; unit?: string; required: boolean; hint?: string;
  showIfId?: string; showIfValue?: string | number | boolean | null; order: number;
};
export type CatalogSeed = { media: SeedMedia[]; installations: SeedInstallation[]; questions: SeedQuestion[] };
