import EmbeddedPostgres from 'embedded-postgres';

const pg = new EmbeddedPostgres({
  databaseDir: './pgdata4',
  user: 'postgres',
  password: 'postgres',
  port: 54332,
  persistent: false,
});

await pg.initialise();
await pg.start();

const c1 = pg.getPgClient();
const c2 = pg.getPgClient();
await c1.connect();
await c2.connect();

const start = Date.now();
const results = await Promise.all([
  c1.query('select pg_sleep(0.3), 1 as who'),
  c2.query('select pg_sleep(0.3), 2 as who'),
]);
console.log('elapsed ms:', Date.now() - start, '(real concurrency expected: ~300-400ms)');
console.log(results.map((r) => r.rows));

await c1.end();
await c2.end();
await pg.stop();
