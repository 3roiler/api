import type { PoolClient, QueryResult } from 'pg';
import { randomBytes, createHash } from 'node:crypto';
import persistence from './persistence.js';
import AppError from './error.js';
import type {
  Printer,
  PrinterAccess,
  PrinterRole,
  PrinterStatus,
  PrinterWithRole
} from '../models/index.js';

/**
 * Columns we project in every list/detail query. Keeping the role +
 * camera-flag inline on the list view saves the Dashboard a second call
 * per card. `agent_token_hash` is never exposed.
 */
const PRINTER_COLUMNS = `
  p.id,
  p.name,
  p.model,
  p.status,
  p.agent_version AS "agentVersion",
  p.last_seen_at AS "lastSeenAt",
  p.created_at AS "createdAt",
  p.updated_at AS "updatedAt"
`;

const ROLE_RANK: Record<PrinterRole, number> = {
  viewer: 1,
  operator: 2,
  owner: 3
};

export interface CreatePrinterOptions {
  name: string;
  model: string;
  ownerUserId: string;
}

export interface CreatePrinterResult {
  printer: PrinterWithRole;
  /** Klartext-Token — nur einmal sichtbar. Danach lebt nur noch der Hash. */
  agentToken: string;
}

export interface UpdatePrinterOptions {
  name?: string;
}

export interface GrantAccessOptions {
  printerId: string;
  userId: string;
  role: PrinterRole;
  canViewCamera?: boolean;
  grantedBy: string;
}

export interface PrinterStatusPatch {
  status?: PrinterStatus;
  agentVersion?: string | null;
  touchLastSeen?: boolean;
}

/**
 * Generates a 96-char hex secret + its SHA-256 hash. Client stores the
 * secret in their agent config; we only ever keep the hash in the DB.
 */
function mintAgentToken(): { token: string; hash: string } {
  const token = randomBytes(48).toString('hex');
  const hash = createHash('sha256').update(token).digest('hex');
  return { token, hash };
}

export class PrinterService {
  /**
   * Lists every printer the viewer has `printer_access` on, including
   * their effective role and camera flag. Sorted so the viewer's own
   * printers (role='owner') bubble up first.
   */
  async listPrintersForUser(userId: string): Promise<PrinterWithRole[]> {
    const result: QueryResult<PrinterWithRole> = await persistence.database.query(
      `SELECT ${PRINTER_COLUMNS},
              pa.role,
              pa.can_view_camera AS "canViewCamera"
       FROM public."printer" p
       JOIN public."printer_access" pa ON pa.printer_id = p.id
       WHERE pa.user_id = $1::uuid
       ORDER BY
         CASE pa.role WHEN 'owner' THEN 0 WHEN 'operator' THEN 1 ELSE 2 END,
         p.created_at DESC`,
      [userId]
    );
    return result.rows;
  }

  /**
   * Fetches a single printer iff the viewer has any access on it. The
   * role is returned inline so the controller can do ACL decisions
   * without a second round-trip.
   */
  async getPrinterForUser(printerId: string, userId: string): Promise<PrinterWithRole | null> {
    const result: QueryResult<PrinterWithRole> = await persistence.database.query(
      `SELECT ${PRINTER_COLUMNS},
              pa.role,
              pa.can_view_camera AS "canViewCamera"
       FROM public."printer" p
       JOIN public."printer_access" pa ON pa.printer_id = p.id
       WHERE p.id = $1::uuid AND pa.user_id = $2::uuid`,
      [printerId, userId]
    );
    return result.rows[0] ?? null;
  }

  /**
   * Internal lookup — no ACL check. Used by the agent handler where
   * auth already ran via the printer-token, not a user session.
   */
  async getPrinterById(printerId: string): Promise<Printer | null> {
    const result: QueryResult<Printer> = await persistence.database.query(
      `SELECT ${PRINTER_COLUMNS} FROM public."printer" p WHERE p.id = $1::uuid`,
      [printerId]
    );
    return result.rows[0] ?? null;
  }

  /**
   * Creates a printer and assigns the caller as owner in a single
   * transaction. Returns the one-shot agent token; caller MUST surface
   * it to the user immediately — we cannot recover it afterwards.
   */
  async createPrinter(options: CreatePrinterOptions): Promise<CreatePrinterResult> {
    const { name, model, ownerUserId } = options;
    const { token, hash } = mintAgentToken();

    return this.withTx(async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO public."printer" (name, model, agent_token_hash)
         VALUES ($1, $2, $3::token_hash)
         RETURNING id`,
        [name, model, hash]
      );
      const printerId = inserted.rows[0].id;

      await client.query(
        `INSERT INTO public."printer_access"
           (printer_id, user_id, role, can_view_camera, granted_by)
         VALUES ($1::uuid, $2::uuid, 'owner', true, $2::uuid)`,
        [printerId, ownerUserId]
      );

      const row: QueryResult<PrinterWithRole> = await client.query(
        `SELECT ${PRINTER_COLUMNS},
                pa.role,
                pa.can_view_camera AS "canViewCamera"
         FROM public."printer" p
         JOIN public."printer_access" pa ON pa.printer_id = p.id
         WHERE p.id = $1::uuid AND pa.user_id = $2::uuid`,
        [printerId, ownerUserId]
      );

      return { printer: row.rows[0], agentToken: token };
    });
  }

  async updatePrinter(printerId: string, updates: UpdatePrinterOptions): Promise<Printer | null> {
    const fields: Array<[string, unknown]> = [['name', updates.name]];
    const setFragments: string[] = [];
    const values: unknown[] = [];

    for (const [column, value] of fields) {
      if (value !== undefined) {
        values.push(value);
        setFragments.push(`${column} = $${values.length}`);
      }
    }

    if (setFragments.length === 0) {
      return this.getPrinterById(printerId);
    }

    values.push(printerId);
    setFragments.push('updated_at = NOW()');

    const result: QueryResult<Printer> = await persistence.database.query(
      `UPDATE public."printer" p
       SET ${setFragments.join(', ')}
       WHERE p.id = $${values.length}::uuid
       RETURNING ${PRINTER_COLUMNS}`,
      values
    );
    return result.rows[0] ?? null;
  }

  async deletePrinter(printerId: string): Promise<boolean> {
    const result = await persistence.database.query(
      'DELETE FROM public."printer" WHERE id = $1::uuid',
      [printerId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Called by the agent service on connect/disconnect. Kept separate
   * from `updatePrinter` because it is triggered from a completely
   * different auth path (printer-token, not user JWT).
   */
  async updateStatus(printerId: string, patch: PrinterStatusPatch): Promise<void> {
    const fragments: string[] = [];
    const values: unknown[] = [];

    if (patch.status !== undefined) {
      values.push(patch.status);
      fragments.push(`status = $${values.length}`);
    }
    if (patch.agentVersion !== undefined) {
      values.push(patch.agentVersion);
      fragments.push(`agent_version = $${values.length}`);
    }
    if (patch.touchLastSeen) {
      fragments.push('last_seen_at = NOW()');
    }

    if (fragments.length === 0) return;
    fragments.push('updated_at = NOW()');
    values.push(printerId);

    await persistence.database.query(
      `UPDATE public."printer" SET ${fragments.join(', ')} WHERE id = $${values.length}::uuid`,
      values
    );
  }

  /**
   * Rotates the agent token. Old hash is overwritten, a fresh token is
   * returned. Callers should immediately force any open WS agents with
   * the old token to reconnect (they'll be rejected at handshake).
   */
  async rotateAgentToken(printerId: string): Promise<string> {
    const { token, hash } = mintAgentToken();
    const result = await persistence.database.query(
      `UPDATE public."printer"
       SET agent_token_hash = $1::token_hash, updated_at = NOW()
       WHERE id = $2::uuid`,
      [hash, printerId]
    );
    if ((result.rowCount ?? 0) === 0) {
      throw AppError.notFound('Printer not found', 'PRINTER_NOT_FOUND');
    }
    return token;
  }

  /**
   * Looks up a printer by raw agent-token. Used by the WS upgrade
   * handler to authenticate an incoming agent connection. SHA-256s the
   * token on the fly and compares against the stored domain-hash.
   */
  async findByAgentToken(token: string): Promise<{ id: string } | null> {
    const hash = createHash('sha256').update(token).digest('hex');
    const result: QueryResult<{ id: string }> = await persistence.database.query(
      `SELECT id FROM public."printer" WHERE agent_token_hash = $1::token_hash`,
      [hash]
    );
    return result.rows[0] ?? null;
  }

  // ─── Access / ACL ─────────────────────────────────────────────────────

  async listAccess(printerId: string): Promise<PrinterAccess[]> {
    const result: QueryResult<PrinterAccess> = await persistence.database.query(
      `SELECT id,
              printer_id AS "printerId",
              user_id AS "userId",
              role,
              can_view_camera AS "canViewCamera",
              granted_by AS "grantedBy",
              granted_at AS "grantedAt"
       FROM public."printer_access"
       WHERE printer_id = $1::uuid
       ORDER BY
         CASE role WHEN 'owner' THEN 0 WHEN 'operator' THEN 1 ELSE 2 END,
         granted_at ASC`,
      [printerId]
    );
    return result.rows;
  }

  async grantAccess(options: GrantAccessOptions): Promise<PrinterAccess> {
    const { printerId, userId, role, canViewCamera = false, grantedBy } = options;
    if (role === 'owner') {
      throw AppError.badRequest(
        'Owner role cannot be granted via this endpoint. Transfer ownership through a dedicated flow.',
        'BAD_ROLE'
      );
    }

    const result: QueryResult<PrinterAccess> = await persistence.database.query(
      `INSERT INTO public."printer_access"
         (printer_id, user_id, role, can_view_camera, granted_by)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid)
       ON CONFLICT (printer_id, user_id) DO UPDATE SET
         role = EXCLUDED.role,
         can_view_camera = EXCLUDED.can_view_camera,
         granted_by = EXCLUDED.granted_by,
         granted_at = NOW()
       RETURNING id,
                 printer_id AS "printerId",
                 user_id AS "userId",
                 role,
                 can_view_camera AS "canViewCamera",
                 granted_by AS "grantedBy",
                 granted_at AS "grantedAt"`,
      [printerId, userId, role, canViewCamera, grantedBy]
    );
    return result.rows[0];
  }

  async revokeAccess(printerId: string, userId: string): Promise<boolean> {
    // Owner row is protected — if the caller aims it at an owner, refuse
    // rather than leaving the printer orphaned.
    const check = await persistence.database.query<{ role: PrinterRole }>(
      `SELECT role FROM public."printer_access"
       WHERE printer_id = $1::uuid AND user_id = $2::uuid`,
      [printerId, userId]
    );
    if (check.rows[0]?.role === 'owner') {
      throw AppError.badRequest(
        'Cannot revoke the owner. Delete the printer or transfer ownership first.',
        'OWNER_PROTECTED'
      );
    }
    const result = await persistence.database.query(
      `DELETE FROM public."printer_access"
       WHERE printer_id = $1::uuid AND user_id = $2::uuid`,
      [printerId, userId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Central ACL check. Returns the viewer's role or throws 403 when
   * insufficient. Controllers call this before anything state-mutating.
   */
  async assertRole(userId: string, printerId: string, minRole: PrinterRole): Promise<PrinterRole> {
    const result: QueryResult<{ role: PrinterRole }> = await persistence.database.query(
      `SELECT role FROM public."printer_access"
       WHERE printer_id = $1::uuid AND user_id = $2::uuid`,
      [printerId, userId]
    );
    const role = result.rows[0]?.role;
    if (!role) {
      throw AppError.notFound('Printer not found', 'PRINTER_NOT_FOUND');
    }
    if (ROLE_RANK[role] < ROLE_RANK[minRole]) {
      throw AppError.forbidden(
        `Insufficient role. Need ${minRole}, have ${role}.`,
        'PRINTER_ACCESS_DENIED'
      );
    }
    return role;
  }

  private async withTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await persistence.database.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

export default new PrinterService();
