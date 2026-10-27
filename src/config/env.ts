import dotenv from 'dotenv';
import { z } from 'zod';

/**
 * Layered environment files (first value wins, real environment variables always win):
 *   1. .env.<NODE_ENV>  environment-specific, non-secret settings (.env.development = local, .env.production = live)
 *   2. .env             shared secrets (MongoDB, JWT, Spaces keys); never committed
 * See .env.development.example / .env.production.example.
 */
const mode = process.env.NODE_ENV ?? 'development';
dotenv.config({ path: `.env.${mode}`, quiet: true });
dotenv.config({ quiet: true });

const optional = z.string().trim().optional().transform((v) => v || undefined);

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().default(4000),
    /** Public URL of THIS API, used to build file links returned to web and mobile. */
    PUBLIC_BASE_URL: z.string().url().default('http://localhost:4000'),
    MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),
    JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 chars'),
    ACCESS_TOKEN_TTL: z.string().default('15m'),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().default(30),
    CORS_ORIGINS: z.string().default('http://localhost:3000'),
    COOKIE_SECURE: z.enum(['true', 'false']).default('false'),
    // Used only if the system DNS cannot resolve the mongodb+srv record (see config/db.ts).
    DNS_SERVERS: z.string().default('8.8.8.8,1.1.1.1'),
    SEED_ADMIN_EMAIL: z.string().optional(),
    SEED_ADMIN_MPIN: z.string().regex(/^\d{4}$/, 'SEED_ADMIN_MPIN must be 4 digits').optional(),

    // ---- File storage ----
    /** local = files on this machine under LOCAL_UPLOAD_PATH; space (or production) = DigitalOcean Spaces. */
    STORAGE_TYPE: z.enum(['local', 'space', 'production']).default('local'),
    LOCAL_UPLOAD_PATH: z.string().default('public/uploads'),
    /** Folder prefix inside the shared bucket so this app never touches other apps' files. */
    STORAGE_PREFIX: z.string().default('signage'),
    /** Upload size limits in bytes. Set in the .env files (no built-in numbers); the web app reads them from GET /files/limits. */
    MAX_FILE_SIZE: z.coerce.number().int().positive(),
    MAX_IMAGE_SIZE: z.coerce.number().int().positive(),
    MAX_VIDEO_SIZE: z.coerce.number().int().positive(),
    SIGNED_URL_TTL_SECONDS: z.coerce.number().int().positive().default(600),
    /** Public URL of the web CRM, used for links inside notification emails. */
    WEB_BASE_URL: z.string().url().default('http://localhost:3000'),
    /** Email notifications. Leave SMTP_HOST empty to keep notifications in-app only (deliveries are recorded as SKIPPED). */
    /** Browser push (Chrome/Edge/Firefox) for people who have allowed notifications. Generate with `npx web-push generate-vapid-keys`. */
    VAPID_PUBLIC_KEY: optional,
    VAPID_PRIVATE_KEY: optional,
    VAPID_SUBJECT: z.string().default('mailto:admin@example.com'),
    /** Read notifications are deleted after this many days (0 keeps them forever). Unread ones are never deleted. */
    NOTIFICATION_READ_RETENTION_DAYS: z.coerce.number().int().min(0).default(7),
    /** How often the clean-up runs. */
    /** Every this many hours, stored files that no project records (e.g. after data was deleted straight from MongoDB) are erased. 0 = off. */
    STORAGE_ORPHAN_CLEANUP_HOURS: z.coerce.number().min(0).default(0),
    /** Files newer than this are never treated as orphans (an upload may still be saving its record). */
    /** Watch the projects collection and clear leftovers within seconds when a project is deleted directly in MongoDB (needs a replica set, e.g. Atlas). */
    STORAGE_ORPHAN_WATCH: z.enum(['true', 'false']).default('false'),
    STORAGE_ORPHAN_GRACE_MINUTES: z.coerce.number().min(1).default(60),
    NOTIFICATION_CLEANUP_INTERVAL_HOURS: z.coerce.number().min(0.01).default(6),
    SMTP_HOST: optional,
    SMTP_PORT: z.coerce.number().int().default(587),
    SMTP_SECURE: z.enum(['true', 'false']).default('false'),
    SMTP_USER: optional,
    SMTP_PASS: optional,
    MAIL_FROM: optional,
    /** PHP mail service for client emails (Customer Onboarding Form). JSON is POSTed here; the PDF goes as a link. Empty = not sent. */
    PHP_MAIL_URL: z.string().trim().url().optional().or(z.literal('').transform(() => undefined)),
    /** Optional key sent to the PHP mail service in the X-Api-Key header. */
    PHP_MAIL_KEY: optional,
    /**
     * Zoho (existing client list in Order Management / Lead Management). OAuth self client: client id + secret + a
     * refresh token. Without them a sample list is served so the screens can be used before Zoho is connected.
     */
    ZOHO_CLIENT_ID: optional,
    ZOHO_CLIENT_SECRET: optional,
    ZOHO_REFRESH_TOKEN: optional,
    /** Which Zoho app holds the customers: `books` (contacts) or `crm` (Accounts). */
    ZOHO_PRODUCT: z.enum(['books', 'crm']).default('books'),
    /** Zoho data centre domain suffix: in, com, eu, com.au ... */
    ZOHO_DC: z.string().trim().default('in'),
    /** Zoho Books organisation id (Books only). */
    ZOHO_ORG_ID: optional,
    DO_SPACES_BUCKET: optional,
    DO_SPACES_ENDPOINT: optional,
    DO_SPACES_REGION: optional,
    DO_SPACES_KEY: optional,
    DO_SPACES_SECRET: optional,
    /** Reserved for public assets; all current files are private and served through signed URLs. */
    DO_SPACES_CDN_BASE: optional,
    /** Who can open an uploaded file straight from its URL: public-read (anyone with the link) or private (signed links only). */
    DO_SPACES_ACL: z.enum(['public-read', 'private']).default('public-read'),
  })
  .superRefine((v, ctx) => {
    if (v.STORAGE_TYPE !== 'local') {
      for (const k of ['DO_SPACES_BUCKET', 'DO_SPACES_ENDPOINT', 'DO_SPACES_REGION', 'DO_SPACES_KEY', 'DO_SPACES_SECRET'] as const) {
        if (!v[k]) ctx.addIssue({ code: 'custom', path: [k], message: `${k} is required when STORAGE_TYPE=${v.STORAGE_TYPE}` });
      }
    }
    if (v.NODE_ENV === 'production') {
      const placeholder = /REPLACE/i;
      for (const k of ['PUBLIC_BASE_URL', 'CORS_ORIGINS', 'WEB_BASE_URL'] as const) {
        if (placeholder.test(v[k])) ctx.addIssue({ code: 'custom', path: [k], message: `${k} still contains a REPLACE placeholder in .env.production` });
      }
      if (v.STORAGE_TYPE === 'local') ctx.addIssue({ code: 'custom', path: ['STORAGE_TYPE'], message: 'Production must use STORAGE_TYPE=space (local disk is not durable on the host)' });
    }
  });

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = {
  ...parsed.data,
  corsOrigins: parsed.data.CORS_ORIGINS.split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean),
  cookieSecure: parsed.data.COOKIE_SECURE === 'true',
  dnsServers: parsed.data.DNS_SERVERS.split(',').map((x) => x.trim()).filter(Boolean),
  isProd: parsed.data.NODE_ENV === 'production',
  /** `production` is accepted as an alias for `space`. */
  storage: parsed.data.STORAGE_TYPE === 'local' ? ('local' as const) : ('space' as const),
  publicBaseUrl: parsed.data.PUBLIC_BASE_URL.replace(/\/+$/, ''),
  webBaseUrl: parsed.data.WEB_BASE_URL.replace(/\/+$/, ''),
  /** Email is sent only when an SMTP server and a From address are configured. */
  mailEnabled: !!(parsed.data.SMTP_HOST && parsed.data.MAIL_FROM),
  phpMailEnabled: !!parsed.data.PHP_MAIL_URL,
  zohoEnabled: !!(parsed.data.ZOHO_CLIENT_ID && parsed.data.ZOHO_CLIENT_SECRET && parsed.data.ZOHO_REFRESH_TOKEN),
  pushEnabled: !!(parsed.data.VAPID_PUBLIC_KEY && parsed.data.VAPID_PRIVATE_KEY),
};
