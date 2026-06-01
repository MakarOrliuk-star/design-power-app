import type { SessionPayload } from "../lib/jwt.js";

declare global {
  namespace Express {
    interface Request {
      user?: SessionPayload;
    }
  }
}

export {};
