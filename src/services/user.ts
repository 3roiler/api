import type { QueryResult } from 'pg';
import persistence from './persistence';
import type { User } from '../models/index.js';
import { UUID } from 'node:crypto';

const USER_COLUMNS = `
  id,
  github_id,
  twitch_id AS "twitchId",
  name,
  display_name AS "displayName",
  email,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

export interface CreateUserOptions {
  name: string;
  displayName?: string | null;
  email?: string | null;
}

export interface UpdateUserOptions {
  name?: string | null;
  displayName?: string | null;
  email?: string | null;
}

export class UserService {
  async getAllUsers(): Promise<User[]> {
    const result: QueryResult<User> = await persistence.database.query(
      `SELECT ${USER_COLUMNS} FROM public."user" ORDER BY created_at DESC`
    );

    return result.rows;
  }

  async getUserByGithubId(githubId: string): Promise<User | null> {
    const result: QueryResult<User> = await persistence.database.query(
      `SELECT u.${USER_COLUMNS}
       FROM public."user" u
       WHERE u.github_id = $1`,
      [githubId]
    );

    return result.rows[0] ?? null;
  }

  async getUserByEmail(email: string): Promise<User | null> {
    const result: QueryResult<User> = await persistence.database.query(
      `SELECT ${USER_COLUMNS} FROM public."user" WHERE lower(email) = lower($1)`,
      [email]
    );

    return result.rows[0] ?? null;
  }

  async getUserById(id: string): Promise<User | null> {
    const result: QueryResult<User> = await persistence.database.query(
      `SELECT ${USER_COLUMNS} FROM public."user" WHERE id = $1`,
      [id]
    );

    return result.rows[0] ?? null;
  }

  async getPermissions(id: string) : Promise<string[]> {
    const result: QueryResult<{ permission: string }> = await persistence.database.query(
      `SELECT up.permission
       FROM public."user_permission" up
       WHERE up.user_id = $1`,
      [id]
    );

    const resultGroup: QueryResult<{ permission: string }> = await persistence.database.query(
      `SELECT gp.permission
       FROM public."user_group" ug
       JOIN public."group_permission" gp ON ug.group_id = gp.group_id
       WHERE ug.user_id = $1`,
      [id]
    );

    return result.rows.map(row => row.permission).concat(resultGroup.rows.map(row => row.permission));
  }

  async hasPermission(id: string, permission: string): Promise<boolean> {
    const permissions = await this.getPermissions(id);
    return permissions.includes(permission);
  }

  /**
   * Grants a permission to a user (idempotent — does nothing if already present).
   */
  async grantPermission(userId: string, permission: string): Promise<void> {
    await persistence.database.query(
      `INSERT INTO public."user_permission" (user_id, permission)
       SELECT $1::uuid, $2
       WHERE NOT EXISTS (
         SELECT 1 FROM public."user_permission"
         WHERE user_id = $1::uuid AND permission = $2
       )`,
      [userId, permission]
    );
  }

  /**
   * Revokes a direct user permission. Returns `true` if a row was deleted,
   * `false` if no matching grant existed. Group-inherited permissions are
   * NOT touched — those are managed via group membership.
   */
  async revokePermission(userId: string, permission: string): Promise<boolean> {
    const result = await persistence.database.query(
      `DELETE FROM public."user_permission"
       WHERE user_id = $1::uuid AND permission = $2`,
      [userId, permission]
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Lists every user with their direct and group-inherited permissions
   * aggregated into a single sorted array per user. Used by the admin UI.
   */
  async getAllUsersWithPermissions(): Promise<Array<User & { permissions: string[]; directPermissions: string[] }>> {
    const result: QueryResult<User & { permissions: string[] | null; directPermissions: string[] | null }> =
      await persistence.database.query(
        `SELECT ${USER_COLUMNS},
          COALESCE(
            ARRAY(
              SELECT DISTINCT p FROM (
                SELECT permission AS p FROM public."user_permission" WHERE user_id = u.id
                UNION
                SELECT gp.permission AS p
                FROM public."user_group" ug
                JOIN public."group_permission" gp ON ug.group_id = gp.group_id
                WHERE ug.user_id = u.id
              ) x
              ORDER BY p
            ),
            ARRAY[]::text[]
          ) AS permissions,
          COALESCE(
            ARRAY(
              SELECT permission FROM public."user_permission"
              WHERE user_id = u.id
              ORDER BY permission
            ),
            ARRAY[]::text[]
          ) AS "directPermissions"
         FROM public."user" u
         ORDER BY created_at DESC`
      );

    return result.rows.map(row => ({
      ...row,
      permissions: row.permissions ?? [],
      directPermissions: row.directPermissions ?? []
    }));
  }

  async authenticate(username: string, password: string): Promise<User | null> {
    const result: QueryResult<{ user_id: string }> = await persistence.database.query(
      `SELECT ul.user_id
       FROM public."user_login" ul
       WHERE ul.username = $1 AND ul.password = crypt($2, ul.password)`,
      [username, password]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const userId = result.rows[0].user_id;
    return this.getUserById(userId);
  }

  async userExists(email: string): Promise<boolean> {
    const result: QueryResult<{ count: string }> = await persistence.database.query(
      `SELECT COUNT(*) AS count
       FROM public."user"
       WHERE email = $1`,
      [email]
    );

    return Number.parseInt(result.rows[0].count, 10) > 0;
  }

  async createUser(options: CreateUserOptions): Promise<User> {
    const { name, displayName = null, email = null } = options;

    const result: QueryResult<User> = await persistence.database.query(
      `INSERT INTO public."user" (name, display_name, email)
       VALUES ($1, $2, $3)
       RETURNING ${USER_COLUMNS}`,
      [name, displayName, email]
    );

    return result.rows[0];
  }

  async updateGithub(userId: string, githubId: string): Promise<void> {
    await persistence.database.query(
      `UPDATE public."user"
       SET github_id = $1, updated_at = NOW()
       WHERE id = $2`,
      [githubId, userId]
    );
  }

  /**
   * Backfills an email on a user row if it is currently NULL.
   * Never overwrites an existing address (OAuth providers may report
   * different emails and we don't want silent changes).
   */
  async setEmailIfMissing(userId: string, email: string): Promise<void> {
    await persistence.database.query(
      `UPDATE public."user"
       SET email = $1, updated_at = NOW()
       WHERE id = $2 AND email IS NULL`,
      [email, userId]
    );
  }

  async getUserByTwitchId(twitchId: string): Promise<User | null> {
    const result: QueryResult<User> = await persistence.database.query(
      `SELECT ${USER_COLUMNS}
       FROM public."user"
       WHERE twitch_id = $1`,
      [twitchId]
    );

    return result.rows[0] ?? null;
  }

  async updateTwitch(userId: string, twitchId: string): Promise<void> {
    await persistence.database.query(
      `UPDATE public."user"
       SET twitch_id = $1, updated_at = NOW()
       WHERE id = $2`,
      [twitchId, userId]
    );
  }

  async saveTwitchToken(userId: string, twitchUserId: string, twitchLogin: string, accessToken: string, refreshToken: string, scopes: string, expiresIn: number): Promise<void> {
    const expiresAt = new Date(Date.now() + expiresIn * 1000);
    await persistence.database.query(
      `INSERT INTO public."twitch_token" (user_id, twitch_user_id, twitch_login, access_token, refresh_token, scopes, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id) DO UPDATE SET
         twitch_user_id = EXCLUDED.twitch_user_id,
         twitch_login = EXCLUDED.twitch_login,
         access_token = EXCLUDED.access_token,
         refresh_token = EXCLUDED.refresh_token,
         scopes = EXCLUDED.scopes,
         expires_at = EXCLUDED.expires_at,
         updated_at = NOW()`,
      [userId, twitchUserId, twitchLogin, accessToken, refreshToken, scopes, expiresAt]
    );
  }

  async getTwitchToken(userId: string): Promise<{ accessToken: string; refreshToken: string; twitchUserId: string; twitchLogin: string; expiresAt: Date } | null> {
    const result = await persistence.database.query(
      `SELECT access_token AS "accessToken", refresh_token AS "refreshToken", twitch_user_id AS "twitchUserId", twitch_login AS "twitchLogin", expires_at AS "expiresAt"
       FROM public."twitch_token"
       WHERE user_id = $1`,
      [userId]
    );

    return result.rows[0] ?? null;
  }

  async createLogin(userId: string, username: string, password: string): Promise<UUID> {
    const result: QueryResult<{ id: UUID }> = await persistence.database.query(
      `INSERT INTO public."user_login" (user_id, username, password)
       VALUES ($1, $2, crypt($3, gen_salt('bf')))
       RETURNING id`,
      [userId, username, password]
    );

    return result.rows[0].id;
  }

  async updateUser(id: string, updates: UpdateUserOptions): Promise<User | null> {
    const fields: Array<[string, unknown]> = [
      ['name', updates.name],
      ['display_name', updates.displayName],
      ['email', updates.email]
    ];

    const setFragments: string[] = [];
    const values: unknown[] = [];

    for (const [column, value] of fields) {
      if (value !== undefined) {
        values.push(value);
        setFragments.push(`${column} = $${values.length}`);
      }
    }

    if (setFragments.length === 0) {
      return this.getUserById(id);
    }

    values.push(id);
    setFragments.push(`updated_at = NOW()`);

    const result: QueryResult<User> = await persistence.database.query(
      `UPDATE public."user"
       SET ${setFragments.join(', ')}
       WHERE id = $${values.length}
       RETURNING ${USER_COLUMNS}`,
      values
    );

    return result.rows[0] ?? null;
  }

  async deleteUser(id: string): Promise<boolean> {
    const result = await persistence.database.query('DELETE FROM public."user" WHERE id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  }  
}

export default new UserService();
