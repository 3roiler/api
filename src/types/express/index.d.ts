import { Session, SessionData } from 'express-session';
import type { JwtPayload } from 'jsonwebtoken';
import type { OAuthSessionStore } from '../auth';

export interface AuthContext {
  token: string;
  payload: JwtPayload | { raw: string };
}

declare module 'express-serve-static-core' {
  interface Request {
    session?: Session & Partial<SessionData>;
    allowAnonymous?: boolean;
    auth?: AuthContext;
  }
}

declare module 'express-session' {
  interface SessionData {
    oauth?: OAuthSessionStore;
  }
}
