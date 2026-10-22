import { Schema, model } from 'mongoose';
import { storedFileSchema } from '../files/storedFile.schema';

export const TEMPLATE_KEYS = ['COMPANY_PROFILE'] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

/**
 * Master email template. Stages load the latest saved values; sent emails keep their own copy (SalesOrder.salesprofile),
 * so editing the template never rewrites history.
 */
const templateSchema = new Schema(
  {
    key: { type: String, enum: TEMPLATE_KEYS, required: true, unique: true },
    name: { type: String, required: true },
    subject: { type: String, required: true },
    body: { type: String, required: true }, // sanitized HTML
    defaultSubject: { type: String, required: true },
    defaultBody: { type: String, required: true },
    /** Company Profile PDF, with its full file metadata (no FileAsset row). */
    pdf: { type: storedFileSchema, default: null },
    version: { type: Number, default: 1 },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
export const EmailTemplate = model('EmailTemplate', templateSchema);

/** First-run content. After that, everything is read from the database. */
export const TEMPLATE_SEED: Record<TemplateKey, { name: string; subject: string; body: string }> = {
  COMPANY_PROFILE: {
    name: 'Company Profile',
    subject: 'Company Profile - Adinn Advertising Services Ltd.',
    body: [
      '<p>Dear {{contactName}},</p>',
      '<p>Greetings from ADINN Signage!</p>',
      '<p>Thank you for your interest in our signage solutions. Please find attached our company profile, which outlines our services, capabilities and recent work for brands across India.</p>',
      '<p>We would be glad to understand your requirements for {{companyName}} and share a detailed proposal.</p>',
      '<p>Best regards,<br>{{senderName}}<br>Business Development Team<br>ADINN Signage</p>',
    ].join(''),
  },
};
