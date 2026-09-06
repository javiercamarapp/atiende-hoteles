import EmbeddedPostgres from 'embedded-postgres';

const pg = new EmbeddedPostgres({
  databaseDir: './pgdata2',
  user: 'postgres',
  password: 'postgres',
  port: 54330,
  persistent: false,
});

try {
  await pg.initialise();
  await pg.start();
  const client = pg.getPgClient();
  await client.connect();
  const version = await client.query('select version()');
  console.log('version:', version.rows[0].version);
  const arch = await client.query("show server_version_num");
  console.log('server_version_num:', arch.rows[0]);
  await client.query('create role authenticated');
  await client.query('create table t(id serial primary key, v text)');
  await client.query('alter table t enable row level security');
  await client.query(`create policy p on t for select to authenticated using (v = current_setting('app.tenant', true))`);
  await client.query(`insert into t (v) values ('a'), ('b')`);
  await client.query('grant select on t to authenticated');
  await client.query('begin');
  await client.query('set local role authenticated');
  await client.query(`select set_config('app.tenant', 'a', true)`);
  const rls = await client.query('select * from t');
  console.log('rls rows (should be 1):', rls.rows);
  await client.query('rollback');
  await client.end();
  await pg.stop();
  console.log('OK: embedded-postgres full lifecycle + RLS works');
} catch (err) {
  console.error('ERROR', err);
  process.exit(1);
}
