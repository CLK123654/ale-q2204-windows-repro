import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const [inputArg, outputArg] = process.argv.slice(2);
if (!inputArg || !outputArg) {
  throw new Error('用法: node run.mjs INPUT_ROOT OUTPUT_ROOT');
}

const inputRoot = path.resolve(inputArg);
const outputRoot = path.resolve(outputArg);
const psql = process.env.PSQL_PATH || (process.platform === 'win32' ? 'psql.exe' : 'psql');
const { sql, deliveryReadme } = await import('./sql.mjs');
const stageRoot = `${outputRoot}.staging-${process.pid}`;

async function outputAbsentOrEmpty(target) {
  try {
    return (await fs.readdir(target)).length === 0;
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
}

if (!await outputAbsentOrEmpty(outputRoot)) {
  throw new Error(`输出目录不是空目录: ${outputRoot}`);
}

await fs.rm(outputRoot, { recursive: true, force: true });
await fs.rm(stageRoot, { recursive: true, force: true });
await fs.mkdir(path.join(stageRoot, 'exports'), { recursive: true });
await fs.cp(inputRoot, path.join(stageRoot, 'input'), { recursive: true });
const executableSql = path.join(stageRoot, 'coldchain_release_audit.sql');
await fs.writeFile(executableSql, sql, 'utf8');

const args = [
  '-X',
  '--no-psqlrc',
  `--host=${process.env.PGHOST || '127.0.0.1'}`,
  `--port=${process.env.PGPORT || '5432'}`,
  `--username=${process.env.PGUSER || 'postgres'}`,
  `--dbname=${process.env.PGDATABASE || 'postgres'}`,
  '--set=ON_ERROR_STOP=on',
  '--file=coldchain_release_audit.sql',
];

const result = spawnSync(psql, args, {
  encoding: 'utf8',
  env: process.env,
  cwd: stageRoot,
  windowsHide: true,
  timeout: 600000,
});

if (result.status !== 0) {
  await fs.rm(stageRoot, { recursive: true, force: true });
  await fs.rm(outputRoot, { recursive: true, force: true });
  process.stderr.write(result.stderr || result.stdout || 'PostgreSQL执行失败\n');
  process.exit(result.status ?? 1);
}

await fs.rm(executableSql, { force: true });
await fs.rm(path.join(stageRoot, 'input'), { recursive: true, force: true });
await fs.mkdir(path.join(stageRoot, 'sql'), { recursive: true });
await fs.writeFile(path.join(stageRoot, 'sql', 'coldchain_release_audit.sql'), sql, 'utf8');
await fs.writeFile(path.join(stageRoot, 'README.md'), deliveryReadme, 'utf8');
await fs.rename(stageRoot, outputRoot);
process.stdout.write(result.stdout || 'PostgreSQL执行完成\n');
