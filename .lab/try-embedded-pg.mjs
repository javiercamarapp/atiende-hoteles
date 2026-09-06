import EmbeddedPostgres from 'embedded-postgres';

const pg = new EmbeddedPostgres({
  databaseDir: './pgdata',
  user: 'postgres',
  password: 'postgres',
  port: 54329,
  persistent: false,
});

try {
  console.log('initialising...');
  await pg.initialise();
  console.log('starting...');
  await pg.start();
  console.log('started ok');
  const { rows } = await pg.query('select version()');
  console.log('version():', JSON.stringify(rows));
  await pg.stop();
  console.log('stopped ok');
} catch (err) {
  console.error('ERROR', err);
  process.exit(1);
}
