// One-time: turns the Self Client "grant code" (api-console.zoho.com > Self Client > Generate Code, valid 10 minutes)
// into a permanent refresh token and writes it into .env as ZOHO_REFRESH_TOKEN. After this the backend renews its own
// access tokens, so ZOHO_ACCESS_TOKEN is no longer needed.
// Usage: npm run zoho:token -- <grant-code>      (ZOHO_CLIENT_ID and ZOHO_CLIENT_SECRET must already be in .env)
import { readFileSync, writeFileSync } from 'node:fs';
import { env } from '../config/env';

async function main() {
  const code = process.argv[2];
  if (!code) throw new Error('Usage: npm run zoho:token -- <grant-code>');
  if (!env.ZOHO_CLIENT_ID || !env.ZOHO_CLIENT_SECRET) throw new Error('Set ZOHO_CLIENT_ID and ZOHO_CLIENT_SECRET in .env first');
  const res = await fetch(`${env.zohoAccountsUrl}/oauth/v2/token`, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: env.ZOHO_CLIENT_ID, client_secret: env.ZOHO_CLIENT_SECRET, code }),
  });
  const json = (await res.json().catch(() => ({}))) as { refresh_token?: string; error?: string };
  if (!json.refresh_token) throw new Error(`Zoho did not return a refresh token (${json.error ?? res.status}). The code is single-use and expires in 10 minutes; generate a new one.`);
  const file = '.env';
  const text = readFileSync(file, 'utf8');
  const line = `ZOHO_REFRESH_TOKEN=${json.refresh_token}`;
  writeFileSync(file, /^ZOHO_REFRESH_TOKEN=.*$/m.test(text) ? text.replace(/^ZOHO_REFRESH_TOKEN=.*$/m, line) : `${text.replace(/\s*$/, '')}\n${line}\n`);
  console.log('ZOHO_REFRESH_TOKEN saved to .env. Restart the backend.');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
