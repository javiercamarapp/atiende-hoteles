import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  const sql = readFileSync(new URL('./migration.sql', import.meta.url), 'utf8');
  await db.exec(sql);
});

async function asTenant(userId: string, fn: () => Promise<void>) {
  await db.exec('begin');
  await db.exec(`set local role authenticated`);
  await db.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId]);
  try {
    await fn();
  } finally {
    await db.exec('rollback');
  }
}

describe('PGlite RLS tenant isolation', () => {
  it('tenant A only sees hotel A reservations', async () => {
    await asTenant('aaaaaaaa-0000-0000-0000-00000000000a', async () => {
      const res = await db.query('select hotel_id, guest_name from reservations');
      expect(res.rows).toHaveLength(1);
      expect((res.rows[0] as any).guest_name).toBe('Guest A1');
    });
  });

  it('tenant B only sees hotel B reservations', async () => {
    await asTenant('bbbbbbbb-0000-0000-0000-00000000000b', async () => {
      const res = await db.query('select hotel_id, guest_name from reservations');
      expect(res.rows).toHaveLength(1);
      expect((res.rows[0] as any).guest_name).toBe('Guest B1');
    });
  });

  it('tenant A cannot insert a reservation into hotel B (RLS with check blocks it)', async () => {
    await expect(
      asTenant('aaaaaaaa-0000-0000-0000-00000000000a', async () => {
        await db.query(
          `insert into reservations (hotel_id, guest_name, idempotency_key)
           values ('22222222-2222-2222-2222-222222222222', 'Intruder', 'hack-1')`
        );
      })
    ).rejects.toThrow();
  });

  it('idempotent create_reservation_idempotent() is safe under ON CONFLICT + advisory lock', async () => {
    await asTenant('aaaaaaaa-0000-0000-0000-00000000000a', async () => {
      const r1 = await db.query(
        `select create_reservation_idempotent('11111111-1111-1111-1111-111111111111', 'Repeat Guest', 'dup-key') as id`
      );
      const r2 = await db.query(
        `select create_reservation_idempotent('11111111-1111-1111-1111-111111111111', 'Repeat Guest Updated', 'dup-key') as id`
      );
      expect((r1.rows[0] as any).id).toBe((r2.rows[0] as any).id);
      const count = await db.query(
        `select count(*)::int as n from reservations where idempotency_key = 'dup-key'`
      );
      expect((count.rows[0] as any).n).toBe(1);
    });
  });

  it('trigger bumps version on update', async () => {
    await asTenant('aaaaaaaa-0000-0000-0000-00000000000a', async () => {
      const before = await db.query(
        `select id, version from reservations where idempotency_key = 'seed-a-1'`
      );
      const id = (before.rows[0] as any).id;
      await db.query(`update reservations set guest_name = 'Guest A1 renamed' where id = $1`, [id]);
      const after = await db.query(`select version from reservations where id = $1`, [id]);
      expect((after.rows[0] as any).version).toBe((before.rows[0] as any).version + 1);
    });
  });
});
