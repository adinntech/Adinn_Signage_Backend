import { createHmac, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../../config/env';

/** Where files physically live. Callers only ever deal in keys like `BD/Client_Details/AMUL/<code>/<file>`. */
export interface StorageProvider {
  readonly type: 'local' | 'space';
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** Removes the stored object. Missing objects are not an error. */
  remove(key: string): Promise<void>;
  /** Short-lived link to read a private object. */
  signedUrl(key: string, fileName: string, ttlSeconds: number): Promise<string>;
  /** Object bytes (e.g. to attach a stored PDF to an email). */
  get(key: string): Promise<Buffer>;
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
    await fs.rm(this.resolve(key), { force: true });
  }

  /** Absolute path of an existing object (throws if it is missing). */
  async read(key: string): Promise<string> {
    const full = this.resolve(key);
    await fs.access(full);
    return full;
  }

  async get(key: string): Promise<Buffer> {
    return fs.readFile(this.resolve(key));
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

  async signedUrl(key: string, _fileName: string, ttlSeconds: number): Promise<string> {
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    const q = new URLSearchParams({ key, exp: String(exp), sig: this.sign(key, exp) });
    return `${this.baseUrl}/api/v1/files/raw?${q.toString()}`;
  }
}

/* ---------------------------------- spaces --------------------------------- */

type S3Like = Pick<S3Client, 'send'>;

export interface SpacesOptions {
  bucket: string;
  prefix: string;
  client: S3Like;
  signer?: (key: string, fileName: string, ttl: number) => Promise<string>;
}

export class SpacesStorage implements StorageProvider {
  readonly type = 'space' as const;
  constructor(private readonly o: SpacesOptions) {}

  private fullKey(key: string) {
    return `${this.o.prefix}/${key}`.replace(/\/{2,}/g, '/');
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.o.client.send(
      new PutObjectCommand({
        Bucket: this.o.bucket,
        Key: this.fullKey(key),
        Body: body,
        ContentType: contentType,
        ACL: 'private', // client documents, signatures and GSTIN data must never be world-readable
      }),
    );
  }

  async remove(key: string): Promise<void> {
    await this.o.client.send(new DeleteObjectCommand({ Bucket: this.o.bucket, Key: this.fullKey(key) }));
  }

  async get(key: string): Promise<Buffer> {
    const out = await this.o.client.send(new GetObjectCommand({ Bucket: this.o.bucket, Key: this.fullKey(key) }));
    const body = out.Body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
    if (!body?.transformToByteArray) throw new Error('Empty object body');
    return Buffer.from(await body.transformToByteArray());
  }

  signedUrl(key: string, fileName: string, ttlSeconds: number): Promise<string> {
    if (!this.o.signer) throw new Error('Spaces signer not configured');
    return this.o.signer(this.fullKey(key), fileName, ttlSeconds);
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
const providers: Partial<Record<StorageProvider['type'], StorageProvider>> = {};

const spacesConfigured = () => !!(env.DO_SPACES_BUCKET && env.DO_SPACES_ENDPOINT && env.DO_SPACES_REGION && env.DO_SPACES_KEY && env.DO_SPACES_SECRET);

function build(type: StorageProvider['type']): StorageProvider {
  if (type === 'local') return new LocalStorage(path.resolve(process.cwd(), env.LOCAL_UPLOAD_PATH), env.JWT_ACCESS_SECRET, env.publicBaseUrl);
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
    signer: (key, fileName, ttl) =>
      getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: env.DO_SPACES_BUCKET!,
          Key: key,
          ResponseContentDisposition: `inline; filename="${fileName.replace(/[^\w.\- ]/g, '_')}"`,
        }),
        { expiresIn: ttl },
      ),
  });
}

/** Where new uploads go (STORAGE_TYPE). */
export function getStorage(): StorageProvider {
  return override ?? (providers[env.storage] ??= build(env.storage));
}

/**
 * The storage a file was uploaded to, so it is read and deleted where it actually lives even after STORAGE_TYPE
 * changes. null when that storage is not configured on this server (e.g. a Spaces file on a local-only dev machine).
 */
export function getStorageFor(type: StorageProvider['type']): StorageProvider | null {
  if (override) return override;
  if (type === env.storage) return getStorage();
  if (type === 'space' && !spacesConfigured()) return null;
  return (providers[type] ??= build(type));
}

/** Tests inject a provider (or reset with undefined). */
export function setStorageForTests(p: StorageProvider | undefined) {
  override = p;
}
