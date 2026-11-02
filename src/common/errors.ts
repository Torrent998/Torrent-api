/** Safe, typed application error. `message` is client-visible: never put secrets in it. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const badRequest = (code: string, m: string) => new AppError(400, code, m);
export const unauthorized = (m = "authentication required") => new AppError(401, "UNAUTHENTICATED", m);
export const forbidden = (m = "not allowed for this principal") => new AppError(403, "FORBIDDEN", m);
export const notFound = (what: string) => new AppError(404, "NOT_FOUND", `${what} not found`);
export const conflict = (code: string, m: string) => new AppError(409, code, m);
export const unprocessable = (code: string, m: string) => new AppError(422, code, m);
export const unavailable = (code: string, m: string) => new AppError(503, code, m);
