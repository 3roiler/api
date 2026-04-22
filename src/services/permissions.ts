/**
 * Central registry of every permission the app checks for. Keeping the list
 * here (rather than scattered across routes/controllers) lets the admin UI
 * enumerate grantable permissions without hitting the DB or hardcoding
 * strings in the frontend.
 *
 * When you add a new `requirePermission('foo.bar')` anywhere, add `foo.bar`
 * here too — otherwise it won't appear in the admin UI's grant dropdown.
 *
 * `admin.manage` is the umbrella: the bootstrap hook always grants it
 * together with the whole `dashboard.*` family, and the permission-check
 * middleware treats it as implicit for every other check.
 */
export interface PermissionDefinition {
  key: string;
  description: string;
}

export const PERMISSIONS: readonly PermissionDefinition[] = [
  { key: 'admin.manage', description: 'Manage users and their permissions via the admin UI.' },
  { key: 'blog.write', description: 'Create, edit, publish and delete blog posts.' },
  { key: 'dashboard.view', description: 'Open the /dashboard shell.' },
  { key: 'dashboard.blog', description: 'Blog management section of the dashboard.' },
  { key: 'dashboard.users', description: 'User management section of the dashboard.' },
  { key: 'dashboard.groups', description: 'Group management section of the dashboard.' },
  { key: 'dashboard.settings', description: 'Site configuration section (tokens, feature flags).' },
  { key: 'dashboard.metrics', description: 'DigitalOcean / database metrics proxy.' },
  { key: 'dashboard.printers', description: '3D-Drucker und G-Code-Dateien verwalten.' }
] as const;

const PERMISSION_KEYS = new Set(PERMISSIONS.map(p => p.key));

export function isKnownPermission(permission: string): boolean {
  return PERMISSION_KEYS.has(permission);
}

export default {
  PERMISSIONS,
  isKnownPermission
};
