// One-time: turns the Self Client "grant code" (api-console.zoho.com > Self Client > Generate Code, valid 10 minutes)
// into a permanent refresh token and writes it into .env. After this the backend renews its own access tokens, so the
// pasted access token is no longer needed.
// Usage:
//   npm run zoho:token -- <grant-code>               main login: ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET -> ZOHO_REFRESH_TOKEN
//   npm run zoho:token -- <grant-code> projectcode   estimates login (scope ZohoBooks.estimates.READ):
//                                                    ZOHO_CLIENT_ID_Projectcode / ZOHO_CLIENT_SECRET_Projectcode -> ZOHO_REFRESH_TOKEN_projectcode
import { readFileSync, writeFileSync } from 'node:fs';
import { env } from '../config/env';

async function main() {
  const code = process.argv[2];
  const profile = (process.argv[3] ?? '').toLowerCase();
  if (!code || (profile && profile !== 'projectcode')) throw new Error('Usage: npm run zoho:token -- <grant-code> [projectcode]');
  const pc = profile === 'projectcode';
  const clientId = pc ? env.ZOHO_CLIENT_ID_Projectcode : env.ZOHO_CLIENT_ID;
  const clientSecret = pc ? env.ZOHO_CLIENT_SECRET_Projectcode : env.ZOHO_CLIENT_SECRET;
  const names = pc ? 'ZOHO_CLIENT_ID_Projectcode and ZOHO_CLIENT_SECRET_Projectcode' : 'ZOHO_CLIENT_ID and ZOHO_CLIENT_SECRET';
  const key = pc ? 'ZOHO_REFRESH_TOKEN_projectcode' : 'ZOHO_REFRESH_TOKEN';
  if (!clientId || !clientSecret) throw new Error(`Set ${names} in .env first`);
  const res = await fetch(`${env.zohoAccountsUrl}/oauth/v2/token`, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, client_secret: clientSecret, code }),
  });
  const json = (await res.json().catch(() => ({}))) as { refresh_token?: string; error?: string };
  if (!json.refresh_token) throw new Error(`Zoho did not return a refresh token (${json.error ?? res.status}). The code is single-use and expires in 10 minutes; generate a new one with the same client.`);
  const file = '.env';
  const text = readFileSync(file, 'utf8');
  const line = `${key}=${json.refresh_token}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  writeFileSync(file, re.test(text) ? text.replace(re, line) : `${text.replace(/\s*$/, '')}\n${line}\n`);
  console.log(`${key} saved to .env. Restart the backend.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
