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
    MAX_FILE_SIZE: z.coerce.number().int().positive().default(52428800),
    MAX_IMAGE_SIZE: z.coerce.number().int().positive().default(3145728),
    MAX_VIDEO_SIZE: z.coerce.number().int().positive().default(10485760),
    SIGNED_URL_TTL_SECONDS: z.coerce.number().int().positive().default(600),
    /** Public URL of the web CRM, used for links inside notification emails. */
    WEB_BASE_URL: z.string().url().default('http://localhost:3000'),
    /** Email notifications. Leave SMTP_HOST empty to keep notifications in-app only (deliveries are recorded as SKIPPED). */
    SMTP_HOST: optional,
    SMTP_PORT: z.coerce.number().int().default(587),
    SMTP_SECURE: z.enum(['true', 'false']).default('false'),
    SMTP_USER: optional,
    SMTP_PASS: optional,
    MAIL_FROM: optional,
    DO_SPACES_BUCKET: optional,
    DO_SPACES_ENDPOINT: optional,
    DO_SPACES_REGION: optional,
    DO_SPACES_KEY: optional,
    DO_SPACES_SECRET: optional,
    /** Reserved for public assets; all current files are private and served through signed URLs. */
    DO_SPACES_CDN_BASE: optional,
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
};
