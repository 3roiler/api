import type { QueryResult } from 'pg';
import persistence from './persistence';
import type { User } from '../models/index.js';
import { UUID } from 'crypto';

const USER_COLUMNS = `
  id,
  github_id,
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

    return parseInt(result.rows[0].count, 10) > 0;
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
