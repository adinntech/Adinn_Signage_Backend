import type { Response } from 'express';

/**
 * Live delivery of notifications to people who have the CRM open (Server-Sent Events).
 * The database stays the source of truth: if a person is offline the notification is simply waiting for them,
 * and the screen also refreshes on focus and on a timer. This only makes the arrival instant.
 *
 * Connections are held in this process. With several server instances you would add a shared channel
 * (Redis pub/sub or a Mongo change stream) behind publish(); nothing else would change.
 */
type Writable = Pick<Response, 'write' | 'end' | 'on'>;

const connections = new Map<string, Set<Writable>>();
const HEARTBEAT_MS = 25_000;

export const openConnections = (userId: string) => connections.get(userId)?.size ?? 0;

const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** Registers a response as a live stream for `userId`. Returns a function that closes it. */
export function subscribe(userId: string, res: Writable, expiresAtMs?: number): () => void {
  const set = connections.get(userId) ?? new Set<Writable>();
  set.add(res);
  connections.set(userId, set);

  res.write('retry: 4000\n');
  res.write(frame('ready', { ok: true }));

  const timers: NodeJS.Timeout[] = [];
  const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
  heartbeat.unref();
  timers.push(heartbeat);

  const close = () => {
    timers.forEach(clearTimeout);
    set.delete(res);
    if (!set.size) connections.delete(userId);
    try {
      res.end();
    } catch {
      /* already closed */
    }
  };

  // A stream must not outlive the login that opened it; the client reconnects with a fresh token.
  if (expiresAtMs) {
    const t = setTimeout(close, Math.max(1000, expiresAtMs - Date.now()));
    t.unref();
    timers.push(t);
  }
  res.on('close', close);
  return close;
}

/** Sends an event to every open screen of one person. Never throws. */
export function publish(userId: string, event: string, data: unknown): number {
  const set = connections.get(userId);
  if (!set?.size) return 0;
  let n = 0;
  for (const res of [...set]) {
    try {
      res.write(frame(event, data));
      n++;
    } catch {
      set.delete(res);
    }
  }
  return n;
}
