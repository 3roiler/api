import config from './config.js';
import userService from './user.js';
import type { User } from '../models/index.js';

const ADMIN_PERMISSIONS = ['blog.write', 'admin.manage'] as const;

/**
 * Idempotent startup hook that grants admin-level permissions to any user
 * whose email matches the configured ADMIN_EMAILS list.
 *
 * Runs on boot so the admin gets their permissions automatically after they
 * first sign in via OAuth — no manual DB intervention required.
 */
async function seedAdminPermissions(): Promise<void> {
  if (config.adminEmails.length === 0) {
    return;
  }

  for (const email of config.adminEmails) {
    const user = await userService.getUserByEmail(email);
    if (!user) {
      console.info(`[bootstrap] admin email ${email} has no user yet — will retry on next boot or after first login.`);
      continue;
    }

    for (const permission of ADMIN_PERMISSIONS) {
      await userService.grantPermission(user.id, permission);
    }
    console.info(`[bootstrap] granted ${ADMIN_PERMISSIONS.length} admin permission(s) to ${email}.`);
  }
}

/**
 * Per-login hook: if the just-authenticated user's email appears in
 * ADMIN_EMAILS, grant them the admin permissions. Covers the case where
 * the server booted before the user existed, or the user's email was only
 * backfilled on a later login — in either scenario `seedAdminPermissions`
 * at startup silently skips them.
 *
 * Case-insensitive match since email addresses are.
 */
async function seedAdminForUser(user: User): Promise<void> {
  if (config.adminEmails.length === 0 || !user.email) {
    return;
  }
  const userEmail = user.email.toLowerCase();
  const match = config.adminEmails.some((e) => e.toLowerCase() === userEmail);
  if (!match) {
    return;
  }

  for (const permission of ADMIN_PERMISSIONS) {
    await userService.grantPermission(user.id, permission);
  }
  console.info(`[bootstrap] granted admin permission(s) to ${user.email} on login.`);
}

export default {
  seedAdminPermissions,
  seedAdminForUser
};
