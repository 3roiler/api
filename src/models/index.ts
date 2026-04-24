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

// ─── 3D-Printer-Integration ───────────────────────────────────────────────

export type PrinterStatus = 'offline' | 'online' | 'error';
export type PrinterRole = 'owner' | 'operator' | 'contributor' | 'viewer';
export type PrintJobState =
  | 'requested'
  | 'queued'
  | 'transferring'
  | 'printing'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface Printer {
  id: UUID;
  name: string;
  model: string;
  status: PrinterStatus;
  agentVersion: string | null;
  lastSeenAt: Date | null;
  createdAt: Date;
  updatedAt: Date | null;
}

/**
 * Printer mit Rollen-Info für den aktuellen Viewer. Wird von den
 * Dashboard-Queries geliefert, damit das Frontend ohne Zweit-Call weiß,
 * welche Aktionen erlaubt sind.
 */
export interface PrinterWithRole extends Printer {
  role: PrinterRole;
  canViewCamera: boolean;
  canViewQueue: boolean;
}

export interface PrinterAccess {
  id: UUID;
  printerId: UUID;
  userId: UUID;
  role: PrinterRole;
  canViewCamera: boolean;
  canViewQueue: boolean;
  grantedBy: UUID | null;
  grantedAt: Date;
}

/**
 * Access row enriched with the referenced user's public info. The
 * printer-access UI renders name + avatar without having to fire a
 * separate user lookup for each row.
 */
export interface PrinterAccessWithUser extends PrinterAccess {
  userName: string;
  userDisplayName: string | null;
  userAvatarUrl: string | null;
}

/**
 * Slicer-extrahierte Metadaten. Alles optional — Cura/Orca/PrusaSlicer
 * schreiben unterschiedliche Kommentar-Header, und bei manuell erzeugten
 * G-Code-Dateien fehlen sie komplett.
 */
export interface GcodeMetadata {
  estimatedSeconds?: number;
  filamentMeters?: number;
  filamentGrams?: number;
  layerCount?: number;
  slicer?: string;
}

export interface GcodeFile {
  id: UUID;
  uploadedByUserId: UUID | null;
  originalFilename: string;
  sha256: string;
  sizeBytes: number;
  metadata: GcodeMetadata;
  createdAt: Date;
}

export interface PrintJob {
  id: UUID;
  printerId: UUID;
  userId: UUID | null;
  gcodeFileId: UUID;
  state: PrintJobState;
  priority: number;
  queuedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  errorMessage: string | null;
  moonrakerJobId: string | null;
  progress: number | null;
}

export interface PrintEvent {
  id: UUID;
  printJobId: UUID;
  eventType: string;
  payload: Record<string, unknown>;
  ts: Date;
}