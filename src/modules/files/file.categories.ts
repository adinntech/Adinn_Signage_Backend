import path from 'node:path';
import type { Permission } from '../roles/roles';

/**
 * What can be uploaded, who may upload it, and the folder it lands in.
 * The server builds every path from these rules; clients only send a category, never a path.
 *
 *   BD    -> Client_Details -> <client> -> <project code> -> excel / images / contact documents
 *   Recce -> <client> -> <project code> -> Images/Original | Images/Edited | Acknowledgement | Expenses
 */
export const FILE_CATEGORIES = [
  'BD_CLIENT_DETAILS',
  'RECCE_IMAGE_ORIGINAL',
  'RECCE_IMAGE_EDITED',
  'RECCE_ACKNOWLEDGEMENT',
  'RECCE_EXPENSE',
  'OPS_SURVEY_PROOF',
  // BD CRM (not tied to a project: stored per sales order, or once for the email template)
  'SALES_COMMENT_ATTACHMENT',
  'SALES_APPROVAL_PROOF',
  'SALES_RATE_CARD_PDF',
  'SALES_HANDOVER_DOCUMENT',
  'SALES_HANDOVER_VOICE_NOTE',
  'LEAD_REQUIREMENT_DOCUMENT',
  'LEAD_ONBOARDING_FORM',
  'CLIENT_GST_CERTIFICATE',
  'TEMPLATE_COMPANY_PROFILE',
] as const;
export type FileCategory = (typeof FILE_CATEGORIES)[number];

export type FileKind = 'image' | 'video' | 'document' | 'sheet' | 'audio';

interface CategoryRule {
  folder: (client: string, project: string) => string;
  /** Permission needed to upload / delete. */
  write: Permission;
  /** Any one of these permissions may view files in the category. */
  read: readonly Permission[];
  /** Allowed file kinds. */
  kinds: readonly FileKind[];
  /**
   * Critical evidence: delete only hides the record, the stored object is kept (never overwritten or erased).
   * Standalone categories document intent only; their owning module enforces when a file may be erased.
   */
  evidence: boolean;
  /**
   * Stored against a sales order or template, never uploaded through the project files endpoint. No FileAsset row:
   * the file's metadata is kept inside the owning record (see storedFile.schema).
   */
  standalone?: boolean;
}

const DOCS = ['sheet', 'document', 'image'] as const;
const IMAGES = ['image'] as const;

export const CATEGORY_RULES: Record<FileCategory, CategoryRule> = {
  BD_CLIENT_DETAILS: { folder: (c, p) => `BD/Client_Details/${c}/${p}`, write: 'projects:write', read: ['projects:read'], kinds: DOCS, evidence: false },
  RECCE_IMAGE_ORIGINAL: { folder: (c, p) => `Recce/${c}/${p}/Images/Original`, write: 'field:execute', read: ['sites:read'], kinds: IMAGES, evidence: true },
  RECCE_IMAGE_EDITED: { folder: (c, p) => `Recce/${c}/${p}/Images/Edited`, write: 'field:execute', read: ['sites:read'], kinds: IMAGES, evidence: false },
  RECCE_ACKNOWLEDGEMENT: { folder: (c, p) => `Recce/${c}/${p}/Acknowledgement`, write: 'field:execute', read: ['sites:read'], kinds: ['image', 'document'], evidence: true },
  RECCE_EXPENSE: { folder: (c, p) => `Recce/${c}/${p}/Expenses`, write: 'field:execute', read: ['sites:read', 'finance:manage'], kinds: ['image', 'document'], evidence: true },
  OPS_SURVEY_PROOF: { folder: (c, p) => `Operations/${c}/${p}/Survey_Proof`, write: 'sites:write', read: ['sites:read'], kinds: DOCS, evidence: true },
  // `p` is the sales order number for these. Deleting a comment erases its files. Approval proof can be erased only
  // until approval is complete; rate card PDFs are never erased; a template PDF is kept once an email has used it.
  SALES_COMMENT_ATTACHMENT: { folder: (c, p) => `BD/Sales/${c}/${p}/Comments`, write: 'sales:write', read: ['sales:read'], kinds: DOCS, evidence: false, standalone: true },
  SALES_APPROVAL_PROOF: { folder: (c, p) => `BD/Sales/${c}/${p}/Approval_Proof`, write: 'sales:write', read: ['sales:read'], kinds: ['document', 'image'], evidence: true, standalone: true },
  SALES_RATE_CARD_PDF: { folder: (c, p) => `BD/Sales/${c}/${p}/Rate_Card`, write: 'sales:write', read: ['sales:read'], kinds: ['document'], evidence: true, standalone: true },
  // BD -> Client Servicing handover: shop list Excel and client documents. Removable only until the order is handed over.
  SALES_HANDOVER_DOCUMENT: { folder: (c, p) => `BD/Sales/${c}/${p}/Handover`, write: 'sales:write', read: ['sales:read'], kinds: DOCS, evidence: false, standalone: true },
  // Voice notes recorded (or uploaded) for the handover. Removable only until the order is handed over.
  SALES_HANDOVER_VOICE_NOTE: { folder: (c, p) => `BD/Sales/${c}/${p}/Handover/Voice_Notes`, write: 'sales:write', read: ['sales:read'], kinds: ['audio'], evidence: false, standalone: true },
  // Lead Management > Requirement Discussion: documents and reference images on requirement notes. Deleting a note erases them.
  LEAD_REQUIREMENT_DOCUMENT: { folder: (c, p) => `BD/Sales/${c}/${p}/Requirements`, write: 'sales:write', read: ['sales:read'], kinds: DOCS, evidence: false, standalone: true },
  // Generated Customer Onboarding Form PDFs. A replaced PDF is erased unless an email already sent it.
  LEAD_ONBOARDING_FORM: { folder: (c, p) => `BD/Sales/${c}/${p}/Onboarding_Form`, write: 'sales:write', read: ['sales:read'], kinds: ['document'], evidence: false, standalone: true },
  // Client Management: GST certificate scans / PDFs, stored per client (`p` is the Client ID). Removing one erases it.
  CLIENT_GST_CERTIFICATE: { folder: (c, p) => `BD/Clients/${c}/${p}/GST_Certificate`, write: 'clients:write', read: ['clients:read'], kinds: ['document', 'image'], evidence: false, standalone: true },
  TEMPLATE_COMPANY_PROFILE: { folder: () => 'BD/Templates/Company_Profile', write: 'templates:manage', read: ['sales:read', 'templates:manage'], kinds: ['document'], evidence: false, standalone: true },
};

/** Which part of the CRM a category belongs to; stored with every file so it is clear where it came from. */
export const SECTION_LABEL: Record<FileCategory, string> = {
  BD_CLIENT_DETAILS: 'BD - Client Details',
  RECCE_IMAGE_ORIGINAL: 'Recce - Original Images',
  RECCE_IMAGE_EDITED: 'Recce - Edited Images',
  RECCE_ACKNOWLEDGEMENT: 'Recce - Acknowledgement',
  RECCE_EXPENSE: 'Recce - Expenses',
  OPS_SURVEY_PROOF: 'Operations - Survey Proof',
  SALES_COMMENT_ATTACHMENT: 'Sales - Comment Attachments',
  SALES_APPROVAL_PROOF: 'Sales - Approval Proof',
  SALES_RATE_CARD_PDF: 'Sales - Rate Card PDF',
  SALES_HANDOVER_DOCUMENT: 'Sales - Handover Documents',
  SALES_HANDOVER_VOICE_NOTE: 'Sales - Handover Voice Notes',
  LEAD_REQUIREMENT_DOCUMENT: 'Lead - Requirement Documents',
  LEAD_ONBOARDING_FORM: 'Lead - Customer Onboarding Form',
  CLIENT_GST_CERTIFICATE: 'Client - GST Certificate',
  TEMPLATE_COMPANY_PROFILE: 'Templates - Company Profile',
};

const EXT_KIND: Record<string, FileKind> = {
  '.jpg': 'image',
  '.jpeg': 'image',
  '.png': 'image',
  '.webp': 'image',
  '.mp4': 'video',
  '.pdf': 'document',
  '.docx': 'document',
  '.pptx': 'document',
  '.doc': 'document',
  '.ppt': 'document',
  '.xls': 'sheet',
  '.webm': 'audio',
  '.m4a': 'audio',
  '.mp3': 'audio',
  '.ogg': 'audio',
  '.wav': 'audio',
  '.xlsx': 'sheet',
  '.csv': 'sheet',
};
export const ALLOWED_EXTENSIONS = Object.keys(EXT_KIND);
export const kindOfFile = (originalName: string): FileKind | null => EXT_KIND[path.extname(originalName).toLowerCase()] ?? null;

/** One safe path segment: letters, digits, dot, dash, underscore. No separators, no `..`, bounded length. */
export function safeSegment(input: string, fallback = 'Unknown', max = 60): string {
  const s = String(input ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/^[._-]+|[._-]+$/g, '')
    .replace(/_{2,}/g, '_')
    .slice(0, max);
  return s || fallback;
}

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');

export interface KeyInput {
  category: FileCategory;
  clientName: string;
  projectCode: string;
  originalName: string;
  now?: Date;
  /** Injectable for deterministic tests. */
  random?: string;
}

/** e.g. BD/Client_Details/AMUL/SGN-AMUL-2026-001/20261019-101530_k3j9x2_shop-list.xlsx */
export function buildFileKey(i: KeyInput): string {
  const ext = path.extname(i.originalName).toLowerCase();
  const base = safeSegment(path.basename(i.originalName, path.extname(i.originalName)), 'file', 80);
  const rand = i.random ?? Math.random().toString(36).slice(2, 8).padEnd(6, '0');
  const folder = CATEGORY_RULES[i.category].folder(safeSegment(i.clientName, 'Client'), safeSegment(i.projectCode, 'Project'));
  return `${folder}/${stamp(i.now ?? new Date())}_${rand}_${base}${ext}`;
}
