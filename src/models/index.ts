import { UUID } from "node:crypto";

export interface User {
  id: UUID;
  name: string;
  displayName: string | null;
  email: string | null;
  twitchId: string | null;
  avatarUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SocialLink {
  id: UUID;
  userId: UUID;
  label: string;
  url: string;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date | null;
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

/**
 * Visibility regime for a blog post.
 *
 * - `public`        – anyone, including anonymous visitors (current default).
 * - `authenticated` – any logged-in user, regardless of groups.
 * - `group`         – only users who belong to at least one of the groups
 *                     linked via `blog_post_group_access`.
 *
 * Authors (users with `blog.write`) always see every post they wrote, and
 * admins see drafts too — visibility applies to *readers*, not authors.
 */
export type BlogPostVisibility = 'public' | 'authenticated' | 'group';

export interface BlogPost {
  id: UUID;
  authorId: UUID;
  slug: string;
  title: string;
  excerpt: string | null;
  content: string;
  publishedAt: Date | null;
  visibility: BlogPostVisibility;
  /**
   * Populated only for the `group` visibility. Empty array otherwise, so
   * the frontend doesn't need a null-check on a field that is visible in
   * the editor for every post.
   */
  accessGroupIds: UUID[];
  createdAt: Date;
  updatedAt: Date | null;
}