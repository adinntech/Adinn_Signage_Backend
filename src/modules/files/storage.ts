import { createHmac, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { Readable } from 'node:stream';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../../config/env';
import { AppError } from '../../common/errors';

/** Where files physically live. Callers only ever deal in keys like `BD/Client_Details/AMUL/<code>/<file>`. */
export interface StorageProvider {
  readonly type: 'local' | 'space';
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** Removes the stored object. Missing objects are not an error. */
  remove(key: string): Promise<void>;
  /** Short-lived link to read a private object. `attachment` makes the browser save it under `fileName`. */
  signedUrl(key: string, fileName: string, ttlSeconds: number, disposition?: Disposition): Promise<string>;
  /** Where the object sits in the bucket: the full path (with the app folder) and the full URL. Only Spaces has one; local files stay key-only. */
  /** The object's bytes, for previews the web app reads through this API (so the bucket needs no CORS rule). */
  stream(key: string): Promise<Readable>;
  locate?(key: string): { path: string; url: string };
}

export type StorageType = 'local' | 'space';
export type Disposition = 'inline' | 'attachment';

/**
 * Content-Disposition header value that keeps the file's ORIGINAL name, including spaces, brackets and non-English
 * characters (RFC 6266: a plain ASCII fallback plus the UTF-8 form).
 */
export function contentDisposition(type: Disposition, fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const utf8 = encodeURIComponent(fileName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${type}; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

/* ---------------------------------- local ---------------------------------- */

export class LocalStorage implements StorageProvider {
  readonly type = 'local' as const;
  constructor(
    private readonly root: string,
    private readonly secret: string,
    private readonly baseUrl: string,
  ) {}

  /** Resolve a key inside the root; refuses anything that would escape it. */
  resolve(key: string): string {
    const full = path.resolve(this.root, key);
    if (full !== this.root && !full.startsWith(this.root + path.sep)) throw new Error('Invalid storage key');
    return full;
  }

  async put(key: string, body: Buffer, _contentType?: string): Promise<void> {
    const full = this.resolve(key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, body, { flag: 'wx' }); // never overwrite an existing file
  }

  async remove(key: string): Promise<void> {
    const full = this.resolve(key);
    await fs.rm(full, { force: true });
    // Remove the folders that are now empty (project, client ...) but never the storage root.
    for (let dir = path.dirname(full); dir !== this.root && dir.startsWith(this.root + path.sep); dir = path.dirname(dir)) {
      try {
        await fs.rmdir(dir); // fails when not empty, which ends the loop
      } catch {
        break;
      }
    }
  }

  async stream(key: string): Promise<Readable> {
    return createReadStream(await this.read(key));
  }

  /** Absolute path of an existing object (throws if it is missing). */
  async read(key: string): Promise<string> {
    const full = this.resolve(key);
    await fs.access(full);
    return full;
  }

  sign(key: string, exp: number): string {
    return createHmac('sha256', this.secret).update(`${key}\n${exp}`).digest('hex');
  }

  verify(key: string, exp: number, sig: string): boolean {
    if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
    const a = Buffer.from(this.sign(key, exp));
    const b = Buffer.from(String(sig));
    return a.length === b.length && timingSafeEqual(a, b);
  }

  async signedUrl(key: string, _fileName: string, ttlSeconds: number, disposition: Disposition = 'inline'): Promise<string> {
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    const q = new URLSearchParams({ key, exp: String(exp), sig: this.sign(key, exp) });
    // The saved name is looked up from the database when the file is served; only the inline/attachment choice travels in the link.
    if (disposition === 'attachment') q.set('dl', '1');
    return `${this.baseUrl}/api/v1/files/raw?${q.toString()}`;
  }
}

/* ---------------------------------- spaces --------------------------------- */

type S3Like = Pick<S3Client, 'send'>;

export interface SpacesOptions {
  bucket: string;
  prefix: string;
  client: S3Like;
  signer?: (key: string, fileName: string, ttl: number, disposition: Disposition) => Promise<string>;
  /** Bucket host, e.g. https://adinn-space.sgp1.digitaloceanspaces.com (or a CDN). With acl public-read this URL opens the file directly. */
  baseUrl?: string;
  /** Object permission applied on upload. Defaults to private. */
  acl?: 'public-read' | 'private';
}

export class SpacesStorage implements StorageProvider {
  readonly type = 'space' as const;
  constructor(private readonly o: SpacesOptions) {}

  private fullKey(key: string) {
    return `${this.o.prefix}/${key}`.replace(/\/{2,}/g, '/');
  }

  async stream(key: string): Promise<Readable> {
    const r = await this.o.client.send(new GetObjectCommand({ Bucket: this.o.bucket, Key: this.fullKey(key) }));
    return r.Body as Readable;
  }

  locate(key: string) {
    const path = this.fullKey(key);
    const base = (this.o.baseUrl ?? '').replace(/\/+$/, '');
    return { path, url: `${base}/${path.split('/').map(encodeURIComponent).join('/')}` };
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.o.client.send(
      new PutObjectCommand({
        Bucket: this.o.bucket,
        Key: this.fullKey(key),
        Body: body,
        ContentType: contentType,
        ACL: this.o.acl ?? 'private',
      }),
    );
  }

  async remove(key: string): Promise<void> {
    await this.o.client.send(new DeleteObjectCommand({ Bucket: this.o.bucket, Key: this.fullKey(key) }));
  }

  signedUrl(key: string, fileName: string, ttlSeconds: number, disposition: Disposition = 'inline'): Promise<string> {
    if (!this.o.signer) throw new Error('Spaces signer not configured');
    return this.o.signer(this.fullKey(key), fileName, ttlSeconds, disposition);
  }
}

/**
 * Maps a stored Spaces URL back to the key used inside this app (without the bucket prefix).
 * Safe replacement for URL-based deletes: decodes %-escapes, accepts only this bucket's host AND this
 * app's prefix (so another app sharing the bucket can never be touched), and returns null for local URLs.
 */
export function keyFromSpaceUrl(url: string, opts: { baseUrls: string[]; prefix: string }): string | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null; // a bare local path such as /uploads/x.jpg
  }
  if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return null;
  const base = opts.baseUrls.map((b) => b.replace(/\/+$/, '')).find((b) => url.startsWith(b + '/'));
  if (!base) throw new Error('URL does not belong to the configured Spaces bucket');
  const basePath = new URL(base).pathname.replace(/\/+$/, '');
  const clean = decodeURIComponent(u.pathname.slice(basePath.length)).replace(/^\/+/, '');
  if (clean.split('/').includes('..')) throw new Error('Invalid Spaces key');
  const p = opts.prefix.replace(/^\/+|\/+$/g, '') + '/';
  if (!clean.startsWith(p)) throw new Error('Spaces key is outside this application folder');
  return clean.slice(p.length);
}

/* --------------------------------- factory --------------------------------- */

let override: StorageProvider | undefined;
const cache: Partial<Record<StorageType, StorageProvider>> = {};

function build(type: StorageType): StorageProvider {
  if (type === 'local') {
    return new LocalStorage(path.resolve(process.cwd(), env.LOCAL_UPLOAD_PATH), env.JWT_ACCESS_SECRET, env.publicBaseUrl);
  }
  {
    if (!env.DO_SPACES_BUCKET || !env.DO_SPACES_ENDPOINT || !env.DO_SPACES_REGION || !env.DO_SPACES_KEY || !env.DO_SPACES_SECRET) {
      throw AppError.conflict('This file is stored in DigitalOcean Spaces, but Spaces is not configured on this server (DO_SPACES_* settings).');
    }
    const client = new S3Client({
      region: env.DO_SPACES_REGION!,
      endpoint: env.DO_SPACES_ENDPOINT!,
      forcePathStyle: false,
      credentials: { accessKeyId: env.DO_SPACES_KEY!, secretAccessKey: env.DO_SPACES_SECRET! },
    });
    return new SpacesStorage({
      bucket: env.DO_SPACES_BUCKET!,
      prefix: env.STORAGE_PREFIX,
      client,
      acl: env.DO_SPACES_ACL,
      baseUrl: env.DO_SPACES_CDN_BASE ?? `https://${env.DO_SPACES_BUCKET}.${new URL(env.DO_SPACES_ENDPOINT!).host}`,
      signer: (key, fileName, ttl, disposition) =>
        getSignedUrl(
          client,
          new GetObjectCommand({
            Bucket: env.DO_SPACES_BUCKET!,
            Key: key,
            ResponseContentDisposition: contentDisposition(disposition, fileName),
          }),
          { expiresIn: ttl },
        ),
    });
  }
}

/**
 * The provider for a given storage type. Every file remembers where it was saved (local or space), so previews, downloads
 * and deletes always go to that place, whatever STORAGE_TYPE is set to now. Only NEW uploads follow STORAGE_TYPE.
 */
export function getStorageFor(type: StorageType): StorageProvider {
  if (override) return override;
  return (cache[type] ??= build(type));
}

/** Where new uploads go. */
export const getStorage = () => getStorageFor(env.storage);

/** Tests inject a provider (or reset with undefined). */
export function setStorageForTests(p: StorageProvider | undefined) {
  override = p;
}
