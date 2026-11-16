import { env } from '../../config/env';
import { AppError } from '../../common/errors';

/**
 * Which Zoho login a call uses: `default` (contacts, payments, vendors) or `projectcode` (estimates: project code
 * and estimation code, the ZOHO_*_projectcode values). `projectcode` falls back to `default` when it is not set.
 */
export type ZohoProfile = 'default' | 'projectcode';

interface Creds {
  accessToken?: string | undefined;
  clientId?: string | undefined;
  clientSecret?: string | undefined;
  refreshToken?: string | undefined;
  /** Name of the .env value, for the error messages. */
  label: string;
}

const projectCodeSet = () =>
  !!(env.ZOHO_ACCESS_TOKEN_projectcode || (env.ZOHO_CLIENT_ID_Projectcode && env.ZOHO_CLIENT_SECRET_Projectcode && env.ZOHO_REFRESH_TOKEN_projectcode));

function credsOf(profile: ZohoProfile): Creds {
  if (profile === 'projectcode' && projectCodeSet()) {
    return {
      accessToken: env.ZOHO_ACCESS_TOKEN_projectcode,
      clientId: env.ZOHO_CLIENT_ID_Projectcode,
      clientSecret: env.ZOHO_CLIENT_SECRET_Projectcode,
      refreshToken: env.ZOHO_REFRESH_TOKEN_projectcode,
      label: 'ZOHO_ACCESS_TOKEN_projectcode',
    };
  }
  return { accessToken: env.ZOHO_ACCESS_TOKEN, clientId: env.ZOHO_CLIENT_ID, clientSecret: env.ZOHO_CLIENT_SECRET, refreshToken: env.ZOHO_REFRESH_TOKEN, label: 'ZOHO_ACCESS_TOKEN' };
}

const canRefresh = (c: Creds) => !!(c.clientId && c.clientSecret && c.refreshToken);

const cached: Partial<Record<ZohoProfile, { token: string; expiresAt: number }>> = {};

/** Zoho access tokens last an hour; one is reused until a minute before it expires. The refresh token never leaves the backend. */
async function accessToken(profile: ZohoProfile): Promise<string> {
  const c = credsOf(profile);
  if (!canRefresh(c)) return c.accessToken!;
  const hit = cached[profile];
  if (hit && hit.expiresAt > Date.now() + 60_000) return hit.token;
  const body = new URLSearchParams({ refresh_token: c.refreshToken!, client_id: c.clientId!, client_secret: c.clientSecret!, grant_type: 'refresh_token' });
  const res = await fetch(`${env.zohoAccountsUrl}/oauth/v2/token`, { method: 'POST', body });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !json.access_token) throw new AppError(502, 'ZOHO_AUTH_FAILED', `Zoho rejected the login (${json.error ?? res.status}). Check the ZOHO_* settings.`);
  cached[profile] = { token: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
  return json.access_token;
}

/** Drops the cached access token of one login (or of all). */
export const resetZohoToken = (profile?: ZohoProfile) => {
  if (profile) delete cached[profile];
  else for (const k of Object.keys(cached) as ZohoProfile[]) delete cached[k];
};

/** GET against Zoho Books; organization_id is added to every call. */
export async function zohoGet<T>(
  path: string,
  params: Record<string, string | number | undefined> = {},
  version: 'v3' | 'v4' = 'v3',
  profile: ZohoProfile = 'default',
): Promise<T> {
  const creds = credsOf(profile);
  if (!env.ZOHO_ORGANIZATION_ID || !(creds.accessToken || canRefresh(creds)))
    throw new AppError(503, 'ZOHO_NOT_CONFIGURED', 'Zoho is not configured. Set the ZOHO_* values in the backend .env.');
  const url = new URL(`${env.zohoApiUrl.replace(/\/v\d+$/, `/${version}`)}${path}`);
  for (const [k, v] of Object.entries({ ...params, organization_id: env.ZOHO_ORGANIZATION_ID })) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  const call = async () => fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${await accessToken(profile)}` } });
  let res = await call();
  if (res.status === 401) {
    if (!canRefresh(creds))
      throw new AppError(502, 'ZOHO_AUTH_FAILED', `The Zoho access token is invalid or expired (they last 1 hour). Put a fresh ${creds.label} in .env, or set up the refresh token.`);
    resetZohoToken(profile);
    res = await call();
  }
  const json = (await res.json().catch(() => ({}))) as T & { code?: number; message?: string };
  if (res.status === 404) throw AppError.notFound('Not found in Zoho');
  if (!res.ok || (json.code !== undefined && json.code !== 0)) throw new AppError(502, 'ZOHO_ERROR', `Zoho: ${json.message ?? res.status}`);
  return json;
}
