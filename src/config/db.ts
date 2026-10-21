import dns from 'node:dns';
import mongoose from 'mongoose';
import { env } from './env';

const OPTIONS = { serverSelectionTimeoutMS: 10000 };

/** Errors from the DNS lookup that `mongodb+srv://` URIs need (SRV/TXT records), as opposed to a bad password or IP allow-list. */
const isSrvLookupError = (e: unknown) => /querySrv|queryTxt/.test(String((e as { message?: string })?.message ?? e));

/**
 * Connects to MongoDB. Some networks/VPNs/security tools run a local DNS stub (127.0.0.1) that refuses SRV queries,
 * which makes `mongodb+srv://` fail with `querySrv ECONNREFUSED`. When that happens, retry once using public DNS
 * (DNS_SERVERS, default Google + Cloudflare) for this process only. Nothing else about the connection changes.
 */
export async function connectDb(uri = env.MONGODB_URI) {
  mongoose.set('strictQuery', true);
  try {
    await mongoose.connect(uri, OPTIONS);
  } catch (e) {
    if (!uri.startsWith('mongodb+srv://') || !isSrvLookupError(e)) throw e;
    const servers = env.dnsServers;
    console.warn(`System DNS could not resolve the MongoDB SRV record (${dns.getServers().join(', ')}). Retrying with ${servers.join(', ')}.`);
    dns.setServers(servers);
    await mongoose.connect(uri, OPTIONS);
  }
}

export const disconnectDb = () => mongoose.disconnect();
