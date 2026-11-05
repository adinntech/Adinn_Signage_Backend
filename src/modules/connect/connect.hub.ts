import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { env } from '../../config/env';
import { verifyAccess } from '../auth/auth.service';

/**
 * Live delivery for Adinn Connect (Socket.IO). The database stays the source of truth: every event is also stored, and
 * the screen reloads from the API after a reconnect. A socket only receives a channel's events after the server has
 * checked that the person may read that channel; removing someone from a channel removes their sockets from its room.
 *
 * Connections are held in this process. With several server instances, add the Socket.IO Redis adapter here.
 */
let io: Server | null = null;

/** Set by the service: may this user read this channel? (kept as a hook so the hub has no database code) */
let canJoin: (userId: string, role: string, channelId: string) => Promise<boolean> = async () => false;
export const setChannelGuard = (fn: typeof canJoin) => {
  canJoin = fn;
};

const room = (channelId: string) => `ch:${channelId}`;
const userRoom = (userId: string) => `user:${userId}`;

export function initConnectSocket(server: HttpServer): Server {
  const isLocalhost = (o: string) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
  io = new Server(server, {
    path: '/socket.io',
    cors: { origin: (origin, cb) => cb(null, !origin || env.corsOrigins.includes(origin) || (!env.isProd && isLocalhost(origin))), credentials: true },
  });
  io.use((socket, next) => {
    try {
      const token = typeof socket.handshake.auth?.token === 'string' ? socket.handshake.auth.token : '';
      const a = verifyAccess(token);
      socket.data.userId = a.sub;
      socket.data.role = a.role;
      next();
    } catch {
      next(new Error('UNAUTHORIZED'));
    }
  });
  io.on('connection', (socket: Socket) => {
    void socket.join(userRoom(socket.data.userId));
    socket.on('channel:join', async (channelId: unknown, ack?: (r: { ok: boolean }) => void) => {
      const ok = typeof channelId === 'string' && /^[a-f\d]{24}$/i.test(channelId) && (await canJoin(socket.data.userId, socket.data.role, channelId).catch(() => false));
      if (ok) await socket.join(room(channelId as string));
      ack?.({ ok });
    });
    socket.on('channel:leave', (channelId: unknown) => {
      if (typeof channelId === 'string') void socket.leave(room(channelId));
    });
    socket.on('typing', (channelId: unknown) => {
      if (typeof channelId === 'string' && socket.rooms.has(room(channelId))) socket.to(room(channelId)).emit('typing', { channelId, userId: socket.data.userId });
    });
  });
  return io;
}

export const emitChannel = (channelId: string, event: string, payload: unknown) => void io?.to(room(channelId)).emit(event, payload);
export const emitUser = (userId: string, event: string, payload: unknown) => void io?.to(userRoom(userId)).emit(event, payload);
export const removeFromRoom = (userId: string, channelId: string) => void io?.in(userRoom(userId)).socketsLeave(room(channelId));
export const closeConnectSocket = () => void io?.close();
