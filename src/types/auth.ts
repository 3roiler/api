export interface OAuthAuthenticatedUser {
  provider: string;
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  avatarUrl: string | null;
  profileUrl: string | null;
  accessToken: string;
  refreshToken: string | null;
  rawProfile: Record<string, unknown>;
}

export interface OAuthSessionEntry {
  provider: string;
  state: string;
  redirect: string | null;
  createdAt: number;
}

export type OAuthSessionStore = Record<string, OAuthSessionEntry | undefined>;
