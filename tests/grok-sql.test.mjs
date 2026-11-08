import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const sqlFile = fileURLToPath(new URL('../supabase/migrations/20261108234500_grok_bridge.sql', import.meta.url));
const base = ['-u', 'postgres', 'psql', '-d', 'grok_sql_test', '-v', 'ON_ERROR_STOP=1', '-t', '-A'];

function psql(sql) {
  return execFileSync('sudo', [...base, '-c', sql], { encoding: 'utf8' }).trim();
}

function psqlAsync(sql) {
  return new Promise((resolve, reject) => {
    execFile('sudo', [...base, '-c', sql], { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message));
      else resolve(stdout.trim());
    });
  });
}

execFileSync('sudo', ['-u', 'postgres', 'psql', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', `select pg_terminate_backend(pid) from pg_stat_activity where datname = 'grok_sql_test' and pid <> pg_backend_pid()`]);
execFileSync('sudo', ['-u', 'postgres', 'psql', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', 'drop database if exists grok_sql_test']);
execFileSync('sudo', ['-u', 'postgres', 'psql', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', 'create database grok_sql_test']);
execFileSync('sudo', ['-u', 'postgres', 'psql', '-d', 'grok_sql_test', '-v', 'ON_ERROR_STOP=1', '-c', `
  create schema if not exists extensions;
  do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
  do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
  do $$ begin create role service_role nologin; exception when duplicate_object then null; end $$;
`]);
execFileSync('sudo', ['-u', 'postgres', 'psql', '-d', 'grok_sql_test', '-v', 'ON_ERROR_STOP=1', '-f', sqlFile], { stdio: 'inherit' });

const refresh = 'ab'.repeat(32);
const access = 'cd'.repeat(32);

function resetOwner() {
  psql(`
    delete from public.grok_access;
    delete from public.grok_session;
    insert into public.grok_session (id, refresh_hash, refresh_expires_at)
    values (1, '${refresh}', now() + interval '1 day');
    insert into public.grok_access (access_hash, expires_at)
    values ('${access}', now() + interval '1 hour');
  `);
}

test('grok_rate rejects short keys and counts a long key', () => {
  assert.equal(psql(`select public.grok_rate('sync', 90, 60)`), 'f');
  assert.equal(psql(`select public.grok_rate('send', 30, 60)`), 'f');
  assert.equal(psql(`select public.grok_rate('read', 90, 60)`), 'f');
  assert.equal(psql(`select public.grok_rate('grok-sync', 1, 60)`), 't');
  assert.equal(psql(`select public.grok_rate('grok-sync', 1, 60)`), 'f');
});

test('two refresh logins both stay valid', async () => {
  resetOwner();
  const [first, second] = await Promise.all([
    psqlAsync(`select public.grok_login_refresh('${refresh}', '${'11'.repeat(32)}', now() + interval '15 minutes')`),
    psqlAsync(`select public.grok_login_refresh('${refresh}', '${'22'.repeat(32)}', now() + interval '15 minutes')`),
  ]);
  assert.equal(first, 't');
  assert.equal(second, 't');
  assert.equal(psql(`select public.grok_access_ok('${'11'.repeat(32)}')`), 't');
  assert.equal(psql(`select public.grok_access_ok('${'22'.repeat(32)}')`), 't');
});

test('a refresh that overlaps revocation does not keep a new access token', async () => {
  resetOwner();
  const holder = psqlAsync(`
    begin;
    select pg_catalog.pg_advisory_xact_lock(611082345);
    select pg_sleep(2);
    update public.grok_session set refresh_hash = null, refresh_expires_at = null where id = 1;
    delete from public.grok_access;
    commit;
  `);
  const started = Date.now();
  while (psql(`select count(*) from pg_locks where locktype = 'advisory' and granted`) === '0') {
    if (Date.now() - started > 4000) throw new Error('The session lock was not taken');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const login = await psqlAsync(`select public.grok_login_refresh('${refresh}', '${'33'.repeat(32)}', now() + interval '15 minutes')`);
  await holder;
  assert.equal(login, 'f');
  assert.equal(psql(`select count(*) from public.grok_access where access_hash = '${'33'.repeat(32)}'`), '0');
  assert.equal(psql(`select count(*) from public.grok_access`), '0');
  assert.equal(psql(`select refresh_hash is null from public.grok_session where id = 1`), 't');
});
