import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const [taskArg, inputArg, referenceArg, implementationArg, evidenceArg] = process.argv.slice(2);
if (!taskArg || !inputArg || !referenceArg || !implementationArg || !evidenceArg) {
  throw new Error('用法: node qa-verify.mjs TASK_ROOT INPUT_ROOT REFERENCE_ROOT IMPLEMENTATION EVIDENCE_ROOT');
}

const taskRoot = path.resolve(taskArg);
const sourceInput = path.resolve(inputArg);
const referenceRoot = path.resolve(referenceArg);
const implementation = path.resolve(implementationArg);
const evidenceRoot = path.resolve(evidenceArg);
const psql = process.env.PSQL_PATH || (process.platform === 'win32' ? 'psql.exe' : 'psql');

async function sha256(file) {
  return crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
}

async function listFiles(root, current = '') {
  const entries = await fs.readdir(path.join(root, current), { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(root, relative));
    else if (entry.isFile()) files.push(relative.replaceAll('\\', '/'));
  }
  return files;
}

async function treeHashes(root) {
  const hashes = {};
  for (const relative of await listFiles(root)) hashes[relative] = await sha256(path.join(root, relative));
  return hashes;
}

async function compareTrees(actual, expected) {
  const actualFiles = await listFiles(actual);
  const expectedFiles = await listFiles(expected);
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error(`文件集合不一致: ${JSON.stringify({ actualFiles, expectedFiles })}`);
  }
  for (const relative of expectedFiles) {
    const [left, right] = await Promise.all([
      fs.readFile(path.join(actual, relative), 'utf8'),
      fs.readFile(path.join(expected, relative), 'utf8'),
    ]);
    if (left.replaceAll('\r\n', '\n') !== right.replaceAll('\r\n', '\n')) {
      throw new Error(`文件内容不一致: ${relative}`);
    }
  }
  return expectedFiles;
}

async function outputIsEmpty(target) {
  try {
    return (await fs.readdir(target)).length === 0;
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
}

function runAudit(input, output) {
  return spawnSync(process.execPath, [implementation, input, output], {
    encoding: 'utf8',
    env: { ...process.env, PSQL_PATH: psql },
    windowsHide: true,
    timeout: 600000,
  });
}

function readCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const header = lines.shift().split(',');
  return lines.map(line => Object.fromEntries(line.split(',').map((value, index) => [header[index], value])));
}

await fs.mkdir(evidenceRoot, { recursive: true });
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ale-q2204-'));
const cleanRuns = [];
let generatedPaths = [];

try {
  const sourceHashes = await treeHashes(sourceInput);
  for (const rootId of ['clean-a', 'clean-b']) {
    const root = path.join(tempRoot, rootId);
    const input = path.join(root, 'input');
    await fs.mkdir(root, { recursive: true });
    await fs.cp(sourceInput, input, { recursive: true });
    const runs = [];
    for (const runId of [1, 2]) {
      const output = path.join(root, `output-${runId}`);
      const result = runAudit(input, output);
      await fs.writeFile(path.join(evidenceRoot, `${rootId}-run-${runId}.log`), `${result.stdout}\n${result.stderr}`, 'utf8');
      if (result.status !== 0) throw new Error(`${rootId}第${runId}次执行失败: ${result.stderr || result.stdout}`);
      generatedPaths = await compareTrees(output, referenceRoot);
      runs.push({ run_id: runId, return_code: result.status, output_started_empty: true, reference_match: true });
    }
    const inputUnchanged = JSON.stringify(await treeHashes(input)) === JSON.stringify(sourceHashes);
    if (!inputUnchanged) throw new Error(`${rootId}输入文件发生变化`);
    cleanRuns.push({ root_id: rootId, input_unchanged: true, runs });
  }

  const mutationInput = path.join(tempRoot, 'positive-input');
  const mutationOutput = path.join(tempRoot, 'positive-output');
  await fs.cp(sourceInput, mutationInput, { recursive: true });
  const policyPath = path.join(mutationInput, 'release_policy.csv');
  const originalPolicy = await fs.readFile(policyPath, 'utf8');
  const changedPolicy = originalPolicy.replace(
    'CHILLED,2.0,8.0,10,80.00,10,15',
    'CHILLED,2.0,8.0,10,80.00,25,15',
  );
  if (changedPolicy === originalPolicy) throw new Error('有效输入变化未应用');
  await fs.writeFile(policyPath, changedPolicy, 'utf8');
  const mutation = runAudit(mutationInput, mutationOutput);
  await fs.writeFile(path.join(evidenceRoot, 'positive-mutation.log'), `${mutation.stdout}\n${mutation.stderr}`, 'utf8');
  if (mutation.status !== 0) throw new Error(`有效输入变化执行失败: ${mutation.stderr || mutation.stdout}`);
  const mutatedRows = readCsv(await fs.readFile(path.join(mutationOutput, 'exports', 'release_decisions.csv'), 'utf8'));
  const relB = mutatedRows.find(row => row.release_id === 'REL-B');
  if (!relB || relB.decision !== 'RELEASE' || relB.primary_reason !== 'CLEAR') {
    throw new Error('偏差时长上限变化没有改变REL-B放行决定');
  }
  const mutationDifferent = await sha256(path.join(mutationOutput, 'exports', 'release_decisions.csv'))
    !== await sha256(path.join(referenceRoot, 'exports', 'release_decisions.csv'));
  if (!mutationDifferent) throw new Error('有效输入变化未改变业务结果');

  const negativeInput = path.join(tempRoot, 'negative-input');
  const negativeOutput = path.join(tempRoot, 'negative-output');
  await fs.cp(sourceInput, negativeInput, { recursive: true });
  const shipmentsPath = path.join(negativeInput, 'shipments.csv');
  const shipments = (await fs.readFile(shipmentsPath, 'utf8')).trimEnd().split(/\r?\n/);
  await fs.writeFile(shipmentsPath, `${shipments.join('\n')}\n${shipments[1]}\n`, 'utf8');
  const negative = runAudit(negativeInput, negativeOutput);
  await fs.writeFile(path.join(evidenceRoot, 'negative-case.log'), `${negative.stdout}\n${negative.stderr}`, 'utf8');
  const failedClosed = negative.status !== 0 && await outputIsEmpty(negativeOutput);
  if (!failedClosed) throw new Error('重复release_id没有失败关闭');

  const attachments = {};
  for (const name of ['输入数据包.zip', 'reference.zip', '关键标准答案.xlsx', '任务规格转化.xlsx']) {
    attachments[name] = { sha256: await sha256(path.join(taskRoot, name)) };
  }
  const psqlVersion = spawnSync(psql, ['--version'], { encoding: 'utf8', windowsHide: true });
  if (psqlVersion.status !== 0) throw new Error('无法读取psql版本');

  const summary = {
    schema_version: 1,
    result: 'PASS',
    task_id: '2204',
    task_slug: 'coldchain_release_history_review',
    runner: {
      os: process.env.RUNNER_OS || process.platform,
      image_os: process.env.ImageOS || null,
      architecture: process.arch,
      os_version: process.env.RUNNER_OS_VERSION || null,
    },
    commit_sha: process.env.GITHUB_SHA || null,
    workflow_run_id: process.env.GITHUB_RUN_ID ? Number(process.env.GITHUB_RUN_ID) : null,
    primary_software: { name: 'PostgreSQL Client', version: psqlVersion.stdout.trim(), executed: true },
    node_version: process.version,
    attachments,
    generated_paths: generatedPaths,
    clean_directory_count: cleanRuns.length,
    process_runs_per_directory: 2,
    clean_runs: cleanRuns,
    positive_mutation: {
      name: '偏差时长上限由10分钟改为25分钟',
      input_changed: true,
      behavior_changed: true,
      rel_b_decision: relB.decision,
      assertions_passed: true,
    },
    negative_case: {
      name: 'shipments.csv出现重复release_id',
      return_code: negative.status,
      failed_closed: true,
      no_stale_deliverables: true,
    },
    reference_match: true,
  };
  await fs.writeFile(path.join(evidenceRoot, 'windows-summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
