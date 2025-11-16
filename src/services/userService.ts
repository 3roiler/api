import pool from '../config/database';
import { User } from '../models';
import { QueryResult } from 'pg';

export class UserService {
  async getAllUsers(): Promise<User[]> {
    const result: QueryResult<User> = await pool.query(
      'SELECT id, username, created_at, updated_at FROM users ORDER BY created_at DESC'
    );
    return result.rows;
  }

  async getUserById(id: number): Promise<User | null> {
    const result: QueryResult<User> = await pool.query(
      'SELECT id, username, created_at, updated_at FROM users WHERE id = $1',
      [id]
    );
    return result.rows[0] || null;
  }

  async createUser(username: string): Promise<User> {
    const result: QueryResult<User> = await pool.query(
      'INSERT INTO users (username) VALUES ($1) RETURNING id, username, created_at, updated_at',
      [username]
    );
    return result.rows[0];
  }

  async updateUser(id: number, username: string): Promise<User | null> {
    const result: QueryResult<User> = await pool.query(
      'UPDATE users SET username = $1, updated_at = NOW() WHERE id = $2 RETURNING id, username, created_at, updated_at',
      [username, id]
    );
    return result.rows[0] || null;
  }

  async deleteUser(id: number): Promise<boolean> {
    const result = await pool.query('DELETE FROM users WHERE id = $1', [id]);
    return result.rowCount !== null && result.rowCount > 0;
  }

  async healthCheck(): Promise<boolean> {
    try {
      await pool.query('SELECT 1');
      return true;
    } catch (error) {
      console.error('Database health check failed:', error);
      return false;
    }
  }
}

export default new UserService();
