/**
 * Central registry of every permission the app checks for. Keeping the list
 * here (rather than scattered across routes/controllers) lets the admin UI
 * enumerate grantable permissions without hitting the DB or hardcoding
 * strings in the frontend.
 *
 * When you add a new `requirePermission('foo.bar')` anywhere, add `foo.bar`
 * here too — otherwise it won't appear in the admin UI's grant dropdown.
 */
export interface PermissionDefinition {
  key: string;
  description: string;
}

export const PERMISSIONS: readonly PermissionDefinition[] = [
  { key: 'admin.manage', description: 'Manage users and their permissions via the admin UI.' },
  { key: 'blog.write', description: 'Create, edit, publish and delete blog posts.' }
] as const;

const PERMISSION_KEYS = new Set(PERMISSIONS.map(p => p.key));

export function isKnownPermission(permission: string): boolean {
  return PERMISSION_KEYS.has(permission);
}

export default {
  PERMISSIONS,
  isKnownPermission
};
