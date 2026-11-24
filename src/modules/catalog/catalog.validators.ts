import { z } from 'zod';
import { objectId } from '../../common/query';
import { CATALOG_ICONS, QUESTION_SCOPES, QUESTION_TYPES, SIDEDNESS } from './catalog.types';

/** Typed text: no control characters and no angle brackets (these names are shown back on the web and the phone). */
const SAFE = /^[^\u0000-\u001f<>]*$/;
const text = (min: number, max: number) => z.string().trim().min(min).max(max).regex(SAFE, 'Contains characters that are not allowed');

export const MEDIA_CODE = /^[A-Z0-9_]{2,30}$/;
export const INSTALLATION_CODE = /^[a-z0-9_]{2,40}$/;
export const QUESTION_ID = /^[a-z0-9_]{2,50}$/;

export const mediaCodeParam = z.object({ code: z.string().regex(MEDIA_CODE, 'Invalid media code') });
export const installationCodeParam = z.object({ code: z.string().regex(INSTALLATION_CODE, 'Invalid installation code') });
export const questionParam = z.object({ uid: objectId });

const unique = (list: string[]) => new Set(list).size === list.length;

/*
 * Each editable field is defined ONCE, without a default. A new entry gets the defaults; an edit (patch) must NOT: a partial schema that
 * still carried the defaults would fill every field the person did not send and overwrite what is stored.
 */
const mediaFields = {
  shortName: text(1, 30),
  name: text(1, 80),
  description: text(0, 200),
  icon: z.enum(CATALOG_ICONS),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Colour like #D71920'),
  illuminated: z.boolean(),
  sidedness: z.enum(SIDEDNESS),
  depthFt: z.number().min(0).max(20),
  thicknessMm: z.number().min(0).max(200),
  installations: z.array(z.string().regex(INSTALLATION_CODE)).max(20).refine(unique, 'An installation is listed twice'),
  active: z.boolean(),
};
export const mediaBody = z.object({
  code: z.string().trim().toUpperCase().regex(MEDIA_CODE, 'Code: 2 to 30 letters, digits or _'),
  shortName: mediaFields.shortName,
  name: mediaFields.name,
  description: mediaFields.description.default(''),
  icon: mediaFields.icon.default('category_outlined'),
  color: mediaFields.color.default('#455A64'),
  illuminated: mediaFields.illuminated.default(false),
  sidedness: mediaFields.sidedness.default('SINGLE'),
  depthFt: mediaFields.depthFt.default(0),
  thicknessMm: mediaFields.thicknessMm.default(0),
  installations: mediaFields.installations.default([]),
  active: mediaFields.active.default(true),
});
export const mediaPatch = z.object(mediaFields).partial().strict();

const installationFields = { name: text(1, 60), description: text(0, 200), icon: z.enum(CATALOG_ICONS), active: z.boolean() };
export const installationBody = z.object({
  code: z.string().trim().toLowerCase().regex(INSTALLATION_CODE, 'Code: 2 to 40 lowercase letters, digits or _'),
  name: installationFields.name,
  description: installationFields.description.default(''),
  icon: installationFields.icon.default('category_outlined'),
  active: installationFields.active.default(true),
});
export const installationPatch = z.object(installationFields).partial().strict();

const showValue = z.union([z.string().trim().max(60), z.number(), z.boolean()]);

export const questionBody = z
  .object({
    scope: z.enum(QUESTION_SCOPES),
    scopeCode: z.string().trim().max(40).default(''),
    id: z.string().trim().toLowerCase().regex(QUESTION_ID, 'Key: 2 to 50 lowercase letters, digits or _'),
    label: text(2, 120),
    type: z.enum(QUESTION_TYPES),
    options: z.array(text(1, 60)).max(20).default([]),
    unit: text(1, 10).optional(),
    required: z.boolean().default(true),
    hint: text(1, 120).optional(),
    showIfId: z.string().trim().toLowerCase().regex(QUESTION_ID).optional(),
    showIfValue: showValue.optional(),
    active: z.boolean().default(true),
  })
  .superRefine((q, ctx) => {
    const bad = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
    if (q.scope === 'COMMON' && q.scopeCode) bad('scopeCode', 'A question for every board has no media or installation');
    if (q.scope !== 'COMMON' && !q.scopeCode) bad('scopeCode', q.scope === 'MEDIA' ? 'Choose the media type' : 'Choose the installation type');
    if (q.type === 'CHOICE') {
      if (q.options.length < 2) bad('options', 'A choice question needs at least two options');
      if (!unique(q.options)) bad('options', 'An option is listed twice');
    } else if (q.options.length) bad('options', 'Only a choice question has options');
    if (q.unit && q.type !== 'NUMBER') bad('unit', 'Only a number question has a unit');
    if (q.showIfId && q.showIfId === q.id) bad('showIfId', 'A question cannot depend on itself');
    if (q.showIfId && q.showIfValue === undefined) bad('showIfValue', 'Say which answer shows this question');
    if (!q.showIfId && q.showIfValue !== undefined) bad('showIfId', 'Say which question the answer belongs to');
  });
/** What may change on an existing question. Its scope, key and type are fixed (answers are stored under the key and its type). `null` clears a value. */
export const questionPatch = z
  .object({
    label: text(2, 120),
    options: z.array(text(1, 60)).max(20),
    unit: text(1, 10).nullable(),
    required: z.boolean(),
    hint: text(1, 120).nullable(),
    showIfId: z.string().trim().toLowerCase().regex(QUESTION_ID).nullable(),
    showIfValue: showValue.nullable(),
    active: z.boolean(),
  })
  .partial()
  .strict();

export const reorderBody = z.object({
  kind: z.enum(['media', 'installations', 'questions']),
  /** Media / installation codes, or question uids (all of one scope and one media / installation), in the new order. */
  ids: z.array(z.string().trim().min(1).max(40)).min(1).max(200),
});

export const catalogQuery = z.object({ version: z.coerce.number().int().min(0).optional() });
