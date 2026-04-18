import type { QueryResult } from 'pg';
import persistence from './persistence.js';
import type { Group, User } from '../models/index.js';

/**
 * Rows surfaced by the admin UI — beyond the base `Group` shape they carry
 * aggregated member counts and the attached permissions so the table can be
 * rendered in a single round-trip.
 */
export interface GroupWithCounts extends Group {
  memberCount: number;
  permissions: string[];
}

export interface GroupDetail extends GroupWithCounts {
  members: Array<{
    id: string;
    name: string;
    displayName: string | null;
    email: string | null;
  }>;
}

const GROUP_COLUMNS = `
  id,
  based_on AS "basedOn",
  key,
  display_name AS "displayName",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

export class GroupService {
  async listGroups(): Promise<GroupWithCounts[]> {
    const result: QueryResult<GroupWithCounts> = await persistence.database.query(
      `SELECT ${GROUP_COLUMNS},
        COALESCE(
          (SELECT COUNT(*)::int FROM public."user_group" ug WHERE ug.group_id = g.id),
          0
        ) AS "memberCount",
        COALESCE(
          ARRAY(
            SELECT permission FROM public."group_permission"
            WHERE group_id = g.id
            ORDER BY permission
          ),
          ARRAY[]::text[]
        ) AS permissions
       FROM public."group" g
       ORDER BY display_name ASC`
    );
    return result.rows;
  }

  async getGroupById(id: string): Promise<Group | null> {
    const result: QueryResult<Group> = await persistence.database.query(
      `SELECT ${GROUP_COLUMNS} FROM public."group" WHERE id = $1`,
      [id]
    );
    return result.rows[0] ?? null;
  }

  async getGroupByKey(key: string): Promise<Group | null> {
    const result: QueryResult<Group> = await persistence.database.query(
      `SELECT ${GROUP_COLUMNS} FROM public."group" WHERE key = $1`,
      [key]
    );
    return result.rows[0] ?? null;
  }

  async getGroupDetail(id: string): Promise<GroupDetail | null> {
    const base = await this.listGroups();
    const group = base.find(g => g.id === id);
    if (!group) return null;

    const members = await persistence.database.query<{
      id: string;
      name: string;
      displayName: string | null;
      email: string | null;
    }>(
      `SELECT u.id, u.name, u.display_name AS "displayName", u.email
       FROM public."user_group" ug
       JOIN public."user" u ON u.id = ug.user_id
       WHERE ug.group_id = $1
       ORDER BY COALESCE(u.display_name, u.name) ASC`,
      [id]
    );

    return { ...group, members: members.rows };
  }

  async createGroup(key: string, displayName: string, basedOn: string | null = null): Promise<Group> {
    const result: QueryResult<Group> = await persistence.database.query(
      `INSERT INTO public."group" (key, display_name, based_on)
       VALUES ($1, $2, $3)
       RETURNING ${GROUP_COLUMNS}`,
      [key, displayName, basedOn]
    );
    return result.rows[0];
  }

  async updateGroup(id: string, updates: { key?: string; displayName?: string }): Promise<Group | null> {
    const fields: Array<[string, unknown]> = [
      ['key', updates.key],
      ['display_name', updates.displayName]
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
      return this.getGroupById(id);
    }

    values.push(id);
    setFragments.push('updated_at = NOW()');

    const result: QueryResult<Group> = await persistence.database.query(
      `UPDATE public."group"
       SET ${setFragments.join(', ')}
       WHERE id = $${values.length}
       RETURNING ${GROUP_COLUMNS}`,
      values
    );
    return result.rows[0] ?? null;
  }

  async deleteGroup(id: string): Promise<boolean> {
    const result = await persistence.database.query(
      `DELETE FROM public."group" WHERE id = $1`,
      [id]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async getMembers(groupId: string): Promise<User[]> {
    const result: QueryResult<User> = await persistence.database.query(
      `SELECT u.id,
              u.github_id,
              u.twitch_id AS "twitchId",
              u.name,
              u.display_name AS "displayName",
              u.email,
              u.created_at AS "createdAt",
              u.updated_at AS "updatedAt"
       FROM public."user_group" ug
       JOIN public."user" u ON u.id = ug.user_id
       WHERE ug.group_id = $1
       ORDER BY COALESCE(u.display_name, u.name) ASC`,
      [groupId]
    );
    return result.rows;
  }

  /**
   * Adds a user to a group. Idempotent — returns `false` if the membership
   * already existed, `true` if a new row was inserted.
   */
  async addMember(groupId: string, userId: string): Promise<boolean> {
    const result = await persistence.database.query(
      `INSERT INTO public."user_group" (user_id, group_id)
       SELECT $1::uuid, $2::uuid
       WHERE NOT EXISTS (
         SELECT 1 FROM public."user_group"
         WHERE user_id = $1::uuid AND group_id = $2::uuid
       )`,
      [userId, groupId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async removeMember(groupId: string, userId: string): Promise<boolean> {
    const result = await persistence.database.query(
      `DELETE FROM public."user_group"
       WHERE group_id = $1::uuid AND user_id = $2::uuid`,
      [groupId, userId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Grants a permission to a group (idempotent).
   */
  async grantPermission(groupId: string, permission: string): Promise<void> {
    await persistence.database.query(
      `INSERT INTO public."group_permission" (group_id, permission)
       SELECT $1::uuid, $2
       WHERE NOT EXISTS (
         SELECT 1 FROM public."group_permission"
         WHERE group_id = $1::uuid AND permission = $2
       )`,
      [groupId, permission]
    );
  }

  async revokePermission(groupId: string, permission: string): Promise<boolean> {
    const result = await persistence.database.query(
      `DELETE FROM public."group_permission"
       WHERE group_id = $1::uuid AND permission = $2`,
      [groupId, permission]
    );
    return (result.rowCount ?? 0) > 0;
  }
}

export default new GroupService();
