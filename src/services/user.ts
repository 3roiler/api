import type { QueryResult } from 'pg';
import { pool } from './persistence';
import type { User } from '../models/index.js';

const USER_COLUMNS = `
  id,
  github_ref AS "githubRef",
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
    const result: QueryResult<User> = await pool.query(
      `SELECT ${USER_COLUMNS} FROM user ORDER BY created_at DESC`
    );

    return result.rows;
  }

  async getUserById(id: string): Promise<User | null> {
    const result: QueryResult<User> = await pool.query(
      `SELECT ${USER_COLUMNS} FROM user WHERE id = $1`,
      [id]
    );

    return result.rows[0] ?? null;
  }

  async findByGithubId(githubRef: string): Promise<User | null> {
    const result: QueryResult<User> = await pool.query(
      `SELECT ${USER_COLUMNS} FROM user WHERE github_ref = $1`,
      [githubRef]
    );
    return result.rows[0] ?? null;
  }

  async createUser(options: CreateUserOptions): Promise<User> {
    const { name, displayName = null, email = null } = options;

    const result: QueryResult<User> = await pool.query(
      `INSERT INTO user (name, display_name, email)
       VALUES ($1, $2, $3)
       RETURNING ${USER_COLUMNS}`,
      [name, displayName, email]
    );

    return result.rows[0];
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

    const result: QueryResult<User> = await pool.query(
      `UPDATE user
       SET ${setFragments.join(', ')}
       WHERE id = $${values.length}
       RETURNING ${USER_COLUMNS}`,
      values
    );

    return result.rows[0] ?? null;
  }

  async deleteUser(id: string): Promise<boolean> {
    const result = await pool.query('DELETE FROM user WHERE id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  }  
}

export default new UserService();
