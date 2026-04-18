import { UUID } from "node:crypto";

export interface User {
  id: UUID;
  name: string;
  displayName: string | null;
  email: string | null;
  twitchId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TwitchTokenData {
  userId: UUID;
  twitchUserId: string;
  twitchLogin: string;
  accessToken: string;
  refreshToken: string;
  scopes: string;
  expiresAt: Date;
}

export interface Group {
  id: UUID;
  basedOn: UUID | null;
  key: string;
  displayName: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserGroup {
  userId: string;
  groupId: string;
  createdAt: Date;
}

export interface UserPermission {
  id: UUID;
  userId: UUID;
  permission: string;
  grantedAt: Date;
}

export interface UserLogin {
  id: string;
  userId: UUID;
  username: string;
  password: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}

export interface GroupPermission {
  id: UUID;
  groupId: UUID;
  permission: string;
  grantedAt: Date;
}

export interface RefreshToken {
  id: string;
  userId: UUID;
  provider: string;
  hash: string;
  expiresAt: Date;
  agent: string | null;
  ipAddress: string | null;
  createdAt: Date;
  revokedAt: Date | null;
  metadata: Record<string, unknown>;
}

export interface BlogPost {
  id: UUID;
  authorId: UUID;
  slug: string;
  title: string;
  excerpt: string | null;
  content: string;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date | null;
}