export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
  static badRequest = (m: string, d?: unknown) => new AppError(400, 'BAD_REQUEST', m, d);
  static unauthorized = (m = 'Authentication required', code = 'UNAUTHORIZED') =>
    new AppError(401, code, m);
  static forbidden = (m = 'You do not have permission to do this') =>
    new AppError(403, 'FORBIDDEN', m);
  static notFound = (m = 'Resource not found') => new AppError(404, 'NOT_FOUND', m);
  static conflict = (m: string) => new AppError(409, 'CONFLICT', m);
}
