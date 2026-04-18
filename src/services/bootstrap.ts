import config from './config.js';
import userService from './user.js';

const ADMIN_PERMISSIONS = ['blog.write'] as const;

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

export default {
  seedAdminPermissions
};
