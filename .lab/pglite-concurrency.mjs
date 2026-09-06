import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
const start = Date.now();
const results = await Promise.all([
  db.query('select pg_sleep(0.3), 1 as who'),
  db.query('select pg_sleep(0.3), 2 as who'),
]);
console.log('elapsed ms:', Date.now() - start, '(if truly concurrent, ~300ms; if serialized, ~600ms)');
console.log(results.map((r) => r.rows));
