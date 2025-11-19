import type { PoolClient, QueryResult } from 'pg';
import pool from '../config/database.js';
import type { Group, Scope, User, UserAuthorization, RefreshToken } from '../models/index.js';
import type { OAuthAuthenticatedUser } from '../types/auth.js';

const USER_COLUMNS = `
  id,
  github_id AS "githubId",
  username,
  display_name AS "displayName",
  email,
  avatar_url AS "avatarUrl",
  profile_url AS "profileUrl",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

const REFRESH_TOKEN_COLUMNS = `
  id,
  user_id AS "userId",
  provider,
  token_hash AS "tokenHash",
  expires_at AS "expiresAt",
  user_agent AS "userAgent",
  ip_address AS "ipAddress",
  created_at AS "createdAt",
  revoked_at AS "revokedAt",
  replaced_by_token_hash AS "replacedByTokenHash",
  metadata
`;

export interface CreateUserOptions {
  username: string;
  displayName?: string | null;
  email?: string | null;
  avatarUrl?: string | null;
  profileUrl?: string | null;
  githubId?: string | null;
}

export interface UpdateUserOptions {
  username?: string;
  displayName?: string | null;
  email?: string | null;
  avatarUrl?: string | null;
  profileUrl?: string | null;
}

export interface CreateRefreshTokenOptions {
  userId: string;
  provider: string;
  tokenHash: string;
  expiresAt: Date;
  userAgent?: string | null;
  ipAddress?: string | null;
  metadata?: Record<string, unknown>;
}

export interface RotateRefreshTokenOptions {
  tokenHash: string;
  expiresAt: Date;
  userAgent?: string | null;
  ipAddress?: string | null;
  metadata?: Record<string, unknown>;
}

export class UserService {
  async getAllUsers(): Promise<User[]> {
    const result: QueryResult<User> = await pool.query(
      `SELECT ${USER_COLUMNS} FROM users ORDER BY created_at DESC`
    );
    return result.rows;
  }

  async getUserById(id: string): Promise<User | null> {
    const result: QueryResult<User> = await pool.query(
      `SELECT ${USER_COLUMNS} FROM users WHERE id = $1`,
      [id]
    );
    return result.rows[0] ?? null;
  }

  async findByGithubId(githubId: string): Promise<User | null> {
    const result: QueryResult<User> = await pool.query(
      `SELECT ${USER_COLUMNS} FROM users WHERE github_id = $1`,
      [githubId]
    );
    return result.rows[0] ?? null;
  }

  async createUser(options: CreateUserOptions): Promise<User> {
    const { username, displayName = null, email = null, avatarUrl = null, profileUrl = null, githubId = null } = options;

    const result: QueryResult<User> = await pool.query(
      `INSERT INTO users (username, display_name, email, avatar_url, profile_url, github_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${USER_COLUMNS}`,
      [username, displayName, email, avatarUrl, profileUrl, githubId]
    );

    return result.rows[0];
  }

  async updateUser(id: string, updates: UpdateUserOptions): Promise<User | null> {
    const fields: Array<[string, unknown]> = [
      ['username', updates.username],
      ['display_name', updates.displayName],
      ['email', updates.email],
      ['avatar_url', updates.avatarUrl],
      ['profile_url', updates.profileUrl]
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

    const result: QueryResult<User> = await pool.query(
      `UPDATE users
       SET ${setFragments.join(', ')}
       WHERE id = $${values.length}
       RETURNING ${USER_COLUMNS}`,
      values
    );

    return result.rows[0] ?? null;
  }

  async deleteUser(id: string): Promise<boolean> {
    const result = await pool.query('DELETE FROM users WHERE id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async createRefreshToken(options: CreateRefreshTokenOptions): Promise<RefreshToken> {
    const metadata = options.metadata ?? {};

    const result: QueryResult<RefreshToken> = await pool.query(
      `INSERT INTO refresh_tokens (user_id, provider, token_hash, expires_at, user_agent, ip_address, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${REFRESH_TOKEN_COLUMNS}`,
      [
        options.userId,
        options.provider,
        options.tokenHash,
        options.expiresAt,
        options.userAgent ?? null,
        options.ipAddress ?? null,
        metadata,
      ]
    );

    return result.rows[0];
  }

  async findRefreshTokenByHash(tokenHash: string): Promise<RefreshToken | null> {
    const result: QueryResult<RefreshToken> = await pool.query(
      `SELECT ${REFRESH_TOKEN_COLUMNS}
       FROM refresh_tokens
       WHERE token_hash = $1`,
      [tokenHash]
    );

    return result.rows[0] ?? null;
  }

  async rotateRefreshToken(
    existingToken: RefreshToken,
    replacement: RotateRefreshTokenOptions
  ): Promise<RefreshToken> {
    const metadata = replacement.metadata ?? {};
    const client: PoolClient = await pool.connect();

    try {
      await client.query('BEGIN');

      await client.query(
        `UPDATE refresh_tokens
         SET revoked_at = NOW(), replaced_by_token_hash = $1
         WHERE id = $2`,
        [replacement.tokenHash, existingToken.id]
      );

      const inserted = await client.query<RefreshToken>(
        `INSERT INTO refresh_tokens (user_id, provider, token_hash, expires_at, user_agent, ip_address, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING ${REFRESH_TOKEN_COLUMNS}`,
        [
          existingToken.userId,
          existingToken.provider,
          replacement.tokenHash,
          replacement.expiresAt,
          replacement.userAgent ?? null,
          replacement.ipAddress ?? null,
          metadata,
        ]
      );

      await client.query('COMMIT');
      return inserted.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async revokeRefreshTokenByHash(tokenHash: string): Promise<void> {
    await pool.query(
      `UPDATE refresh_tokens
       SET revoked_at = NOW()
       WHERE token_hash = $1 AND revoked_at IS NULL`,
      [tokenHash]
    );
  }

  async revokeRefreshTokensForUser(userId: string): Promise<void> {
    await pool.query(
      `UPDATE refresh_tokens
       SET revoked_at = NOW()
       WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId]
    );
  }

  async upsertOAuthUser(authUser: OAuthAuthenticatedUser): Promise<User> {
    if (authUser.provider === 'github') {
      return this.upsertGithubUser(authUser);
    }

    throw new Error(`OAuth provider ${authUser.provider} is not supported.`);
  }

  private async upsertGithubUser(authUser: OAuthAuthenticatedUser): Promise<User> {
    const result: QueryResult<User> = await pool.query(
      `INSERT INTO users (github_id, username, display_name, email, avatar_url, profile_url)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (github_id) DO UPDATE SET
         username = EXCLUDED.username,
         display_name = EXCLUDED.display_name,
         email = EXCLUDED.email,
         avatar_url = EXCLUDED.avatar_url,
         profile_url = EXCLUDED.profile_url,
         updated_at = NOW()
       RETURNING ${USER_COLUMNS}`,
      [
        authUser.id,
        authUser.username,
        authUser.displayName,
        authUser.email,
        authUser.avatarUrl,
        authUser.profileUrl
      ]
    );

    return result.rows[0];
  }

  async getUserAuthorization(userId: string): Promise<UserAuthorization> {
    const user = await this.getUserById(userId);

    if (!user) {
      throw new Error(`User with id ${userId} not found.`);
    }

    const groups = await this.getUserGroups(userId);
    const scopes = await this.getUserScopes(userId);

    return {
      user,
      groups,
      scopes
    };
  }
  
  private async getUserGroups(userId: string): Promise<Group[]> {
    const result: QueryResult<Group> = await pool.query(
      `WITH RECURSIVE group_tree AS (
         SELECT g.id,
                g.slug,
                g.name,
                g.description,
                g.created_at,
                g.updated_at
         FROM groups g
         INNER JOIN user_groups ug ON ug.group_id = g.id
         WHERE ug.user_id = $1

         UNION

         SELECT parent.id,
                parent.slug,
                parent.name,
                parent.description,
                parent.created_at,
                parent.updated_at
         FROM groups parent
         INNER JOIN group_dependencies gd ON gd.dependency_group_id = parent.id
         INNER JOIN group_tree child ON child.id = gd.group_id
       )
       SELECT DISTINCT
         id,
         slug,
         name,
         description,
         created_at AS "createdAt",
         updated_at AS "updatedAt"
       FROM group_tree
       ORDER BY slug ASC`,
      [userId]
    );

    return result.rows;
  }

  private async getUserScopes(userId: string): Promise<Scope[]> {
    const result: QueryResult<Scope> = await pool.query(
      `WITH RECURSIVE group_tree AS (
         SELECT g.id
         FROM groups g
         INNER JOIN user_groups ug ON ug.group_id = g.id
         WHERE ug.user_id = $1

         UNION

         SELECT parent.id
         FROM groups parent
         INNER JOIN group_dependencies gd ON gd.dependency_group_id = parent.id
         INNER JOIN group_tree child ON child.id = gd.group_id
       )
       SELECT DISTINCT
         s.id,
         s.key,
         s.description,
         s.created_at AS "createdAt",
         s.updated_at AS "updatedAt"
       FROM group_tree gt
       INNER JOIN group_scopes gs ON gs.group_id = gt.id
       INNER JOIN scopes s ON s.id = gs.scope_id
       ORDER BY s.key ASC`,
      [userId]
    );

    return result.rows;
  }
}

export default new UserService();
