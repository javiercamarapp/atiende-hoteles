import EmbeddedPostgres from 'embedded-postgres';

const pg = new EmbeddedPostgres({
  databaseDir: './pgdata3',
  user: 'postgres',
  password: 'postgres',
  port: 54331,
  persistent: false,
});

await pg.initialise();
await pg.start();
console.log('running on 54331');
// keep alive for 25s
await new Promise((r) => setTimeout(r, 25000));
await pg.stop();
console.log('stopped');
