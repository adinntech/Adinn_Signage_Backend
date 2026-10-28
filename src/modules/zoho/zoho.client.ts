import { env } from '../../config/env';
import { AppError } from '../../common/errors';

let cached: { token: string; expiresAt: number } | null = null;

/** Zoho access tokens last an hour; one is reused until a minute before it expires. The refresh token never leaves the backend. */
async function accessToken(): Promise<string> {
  if (!env.zohoCanRefresh) return env.ZOHO_ACCESS_TOKEN!;
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const body = new URLSearchParams({
    refresh_token: env.ZOHO_REFRESH_TOKEN!,
    client_id: env.ZOHO_CLIENT_ID!,
    client_secret: env.ZOHO_CLIENT_SECRET!,
    grant_type: 'refresh_token',
  });
  const res = await fetch(`${env.zohoAccountsUrl}/oauth/v2/token`, { method: 'POST', body });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !json.access_token) throw new AppError(502, 'ZOHO_AUTH_FAILED', `Zoho rejected the login (${json.error ?? res.status}). Check the ZOHO_* settings.`);
  cached = { token: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
  return cached.token;
}

export const resetZohoToken = () => {
  cached = null;
};

/** GET against Zoho Books; organization_id is added to every call. */
export async function zohoGet<T>(path: string, params: Record<string, string | number | undefined> = {}, version: 'v3' | 'v4' = 'v3'): Promise<T> {
  if (!env.zohoEnabled) throw new AppError(503, 'ZOHO_NOT_CONFIGURED', 'Zoho is not configured. Set the ZOHO_* values in the backend .env.');
  const url = new URL(`${env.zohoApiUrl.replace(/\/v\d+$/, `/${version}`)}${path}`);
  for (const [k, v] of Object.entries({ ...params, organization_id: env.ZOHO_ORGANIZATION_ID })) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  const call = async () => fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${await accessToken()}` } });
  let res = await call();
  if (res.status === 401) {
    if (!env.zohoCanRefresh) throw new AppError(502, 'ZOHO_AUTH_FAILED', 'The Zoho access token is invalid or expired (they last 1 hour). Put a fresh ZOHO_ACCESS_TOKEN in .env, or set up the refresh token.');
    resetZohoToken();
    res = await call();
  }
  const json = (await res.json().catch(() => ({}))) as T & { code?: number; message?: string };
  if (res.status === 404) throw AppError.notFound('Not found in Zoho');
  if (!res.ok || (json.code !== undefined && json.code !== 0)) throw new AppError(502, 'ZOHO_ERROR', `Zoho: ${json.message ?? res.status}`);
  return json;
}
