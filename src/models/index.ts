import { UUID } from "crypto";

export interface User {
  id: UUID;
  githubRef: string | null;
  name: string;
  displayName: string | null;
  email: string | null;
  createdAt: Date;
  updatedAt: Date;
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