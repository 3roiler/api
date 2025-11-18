export interface GitHubAuthUser {
  provider: 'github';
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
