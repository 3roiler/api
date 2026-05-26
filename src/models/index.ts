import { UUID } from "node:crypto";

export interface User {
  id: UUID;
  name: string;
  displayName: string | null;
  email: string | null;
  twitchId: string | null;
  avatarUrl: string | null;
  /** Zeitpunkt der Self-Anonymisierung. NULL = aktiver User.
   *  Bei gesetzt: PII ist genullt, Name + DisplayName lauten
   *  „Gelöschter Nutzer", Login ist gesperrt. Verknüpfte Daten
   *  (Clips, Kommentare, etc.) bleiben sichtbar. */
  deletedAt: Date | null;
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

/**
 * STL-Datei. Slicer-Eingabe; ein STL alleine kann nicht gedruckt
 * werden — das Slicing nach G-Code passiert (vorerst) lokal beim
 * Spieler. Schema bewusst parallel zu `GcodeFile` gehalten, damit
 * Frontends mit demselben Pattern arbeiten können.
 */
export interface StlMetadata {
  /** ASCII vs binary STL — Viewer nutzt unterschiedliche Parser. */
  format?: 'ascii' | 'binary';
  /** Triangle-Count, falls aus dem Header lesbar. */
  triangleCount?: number;
}

export interface StlFile {
  id: UUID;
  uploadedByUserId: UUID | null;
  originalFilename: string;
  sha256: string;
  sizeBytes: number;
  metadata: StlMetadata;
  createdAt: Date;
}

// ─── Print-Request ─────────────────────────────────────────────────────────

export type PrintRequestStatus =
  | 'new'
  | 'accepted'
  | 'printing'
  | 'done'
  | 'rejected'
  | 'cancelled';

export type PrintRequestSourceType = 'stl_upload' | 'external_link';

/**
 * A human-to-human ticket: someone asks the printer-owner to print
 * something. Independent of the agent / print_job pipeline so it
 * works even when nothing is automated yet (USB-stick fulfilment is
 * a valid use case).
 */
export interface PrintRequest {
  id: UUID;
  requesterUserId: UUID;
  title: string;
  description: string | null;
  sourceType: PrintRequestSourceType;
  /** Set when sourceType === 'stl_upload'. */
  stlFileId: UUID | null;
  /** Set when sourceType === 'external_link'. */
  externalUrl: string | null;
  /** Filled by the moderator once a printer is picked. */
  assignedPrinterId: UUID | null;
  status: PrintRequestStatus;
  createdAt: Date;
  updatedAt: Date | null;
}

/**
 * `PrintRequest` joined with the bits the UI always needs alongside it
 * (requester display, optional STL filename, optional printer name).
 * Spares the frontend a fan-out of follow-up calls per row.
 */
export interface PrintRequestWithContext extends PrintRequest {
  requesterName: string;
  requesterDisplayName: string | null;
  requesterAvatarUrl: string | null;
  stlFilename: string | null;
  printerName: string | null;
}

export interface PrintRequestComment {
  id: UUID;
  requestId: UUID;
  authorUserId: UUID;
  body: string;
  createdAt: Date;
}

export interface PrintRequestCommentWithAuthor extends PrintRequestComment {
  authorName: string;
  authorDisplayName: string | null;
  authorAvatarUrl: string | null;
}

// ─── Streamclips Germany ────────────────────────────────────────────────────

/**
 * Macro-Gruppierung über die Twitch-Kategorie (Achse A). Hält die Liste
 * synchron mit dem CHECK auf `twitch_category.section` und dem Frontend.
 */
export type ClipSection =
  | 'gaming'
  | 'just_chatting'
  | 'irl'
  | 'music'
  | 'esports'
  | 'creative'
  | 'other';

/** Moderations-Status eines Clips. Nur `approved` erscheint im Vote-Feed. */
export type ClipStatus = 'pending' | 'approved' | 'rejected' | 'flagged';

export type ClipReportStatus = 'open' | 'resolved' | 'dismissed';

/**
 * Gecachte Twitch-Kategorie (game_id) inkl. unserer Sektions-Zuordnung.
 * `id` ist die Twitch game_id selbst.
 */
export interface TwitchCategory {
  id: string;
  name: string;
  boxArtUrl: string | null;
  section: ClipSection;
  createdAt: Date;
  updatedAt: Date | null;
}

/**
 * Award-Kategorie (Achse B) — die "lustigster / bester Play / …"-Labels,
 * die Nutzer beim Voten vergeben.
 */
export interface AwardCategory {
  id: UUID;
  key: string;
  displayName: string;
  description: string | null;
  emoji: string | null;
  color: string | null;
  isActive: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date | null;
}

export interface Clip {
  id: UUID;
  twitchClipId: string;
  submittedByUserId: UUID;
  title: string;
  /**
   * URL-Slug aus dem Twitch-Titel — Teil der kanonischen Clip-URL
   * (`/streamclips/clip/<slug>-<shortid>`). Wird bei jedem Submit aus
   * `title` generiert (siehe `slugifyTitle` in `services/clip.ts`).
   * Eindeutigkeit kommt aus der shortid, nicht aus dem Slug; deshalb
   * KEIN UNIQUE-Constraint in der DB. Nie leer — Fallback `'clip'`.
   */
  slug: string;
  broadcasterId: string | null;
  broadcasterName: string | null;
  creatorName: string | null;
  gameId: string | null;
  thumbnailUrl: string | null;
  embedUrl: string | null;
  videoUrl: string | null;
  durationSeconds: number | null;
  viewCount: number;
  language: string | null;
  clipCreatedAt: Date | null;
  status: ClipStatus;
  rejectionReason: string | null;
  createdAt: Date;
  updatedAt: Date | null;
}

/** Award-Zählung für einen Clip (Detail-/Leaderboard-Ansicht). */
export interface ClipAwardTally {
  key: string;
  displayName: string;
  emoji: string | null;
  color: string | null;
  count: number;
}

/**
 * `Clip` angereichert um die Bits, die List-/Detail-/Leaderboard-Views
 * immer brauchen — erspart dem Frontend N+1-Lookups. Aggregat-Felder
 * (`ratingCount`, `avgScore`, `awards`) werden im Service zu number/float
 * gecastet (Postgres liefert COUNT/AVG als string).
 */
export interface ClipWithContext extends Clip {
  submitterName: string;
  submitterDisplayName: string | null;
  submitterAvatarUrl: string | null;
  categoryName: string | null;
  section: ClipSection | null;
  ratingCount: number;
  avgScore: number | null;
  awards: ClipAwardTally[];
}

export interface ClipRating {
  id: UUID;
  clipId: UUID;
  userId: UUID;
  /** 1–5, oder null bei Skip/Enthaltung. */
  score: number | null;
  isSkipped: boolean;
  createdAt: Date;
  updatedAt: Date | null;
}

export interface ClipReport {
  id: UUID;
  clipId: UUID;
  reporterUserId: UUID;
  reason: string;
  status: ClipReportStatus;
  createdAt: Date;
  resolvedAt: Date | null;
  resolvedBy: UUID | null;
}

export type CommentTargetType = 'clip' | 'blog_post';

export interface Comment {
  id: UUID;
  parentCommentId: UUID | null;
  targetType: CommentTargetType;
  targetId: UUID;
  userId: UUID;
  body: string;
  /** Sekunden im Clip — `null` für Blog-Posts oder Clip-Kommentare
   *  ohne Zeitbezug. */
  timestampSeconds: number | null;
  /** Soft-Delete-Marker. */
  deletedAt: Date | null;
  deletedByUserId: UUID | null;
  /** Wenn Moderator gelöscht hat: Grund. Bei Self-Delete NULL. */
  deletionReason: string | null;
  createdAt: Date;
  updatedAt: Date | null;
}

/** Kommentar inkl. Author-Anzeigedaten. Author kann anonymisiert sein
 *  (`authorDeletedAt` gesetzt) — Frontend zeigt dann „Gelöschter Nutzer". */
export interface CommentWithAuthor extends Comment {
  authorName: string;
  authorDisplayName: string | null;
  authorAvatarUrl: string | null;
  authorDeletedAt: Date | null;
}

export interface CommentMute {
  userId: UUID;
  reason: string;
  mutedByUserId: UUID;
  mutedUntil: Date | null;
  createdAt: Date;
}