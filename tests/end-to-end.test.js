import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { initializeSkill } from '../src/initialize.js';

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PROJECT_MODE = JSON.parse(await readFile(path.join(PROJECT_ROOT, 'package.json'), 'utf8')).scaffold.mode;
const sourceTest = PROJECT_MODE === 'source' ? test : test.skip;
const COMPLETE_FIXTURE = path.join(PROJECT_ROOT, 'tests', 'fixtures', 'complete-skill');
const DELIVERY_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'delivery-gate.js');
const NPM_CLI = [
  process.env.npm_execpath,
  path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  path.resolve(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
].filter(Boolean).find((candidate) => existsSync(candidate));
const FIXED_NOW = new Date('2026-08-19T00:00:00.000Z');
const ORIGIN = 'https://example.invalid/skill-development-scaffold.git';

function outputMessage(result) {
  return [result.stdout, result.stderr].filter(Boolean).join('\n');
}

async function run(command, args, cwd) {
  const env = {
    ...process.env,
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
  };
  delete env.NODE_TEST_CONTEXT;
  try {
    return await execFileAsync(command, args, {
      cwd,
      encoding: 'utf8',
      env,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (error) {
    assert.fail(`${command} ${args.join(' ')} failed:\n${outputMessage(error)}`);
  }
}

async function runGit(root, args) {
  return run('git', args, root);
}

async function runNpm(root, args) {
  // 直接运行 npm 的 JavaScript 入口，避免测试代码依赖平台特定 shell。
  assert.ok(NPM_CLI, 'npm CLI JavaScript entry was not found');
  return run(process.execPath, [NPM_CLI, ...args], root);
}

function splitRelative(relativePath) {
  return relativePath.split('/');
}

async function createSourceRepository(t) {
  const parent = await mkdtemp(path.join(tmpdir(), 'skill-scaffold-e2e-'));
  const root = path.join(parent, 'repository');
  t.after(() => rm(parent, { recursive: true, force: true }));
  await cp(PROJECT_ROOT, root, {
    recursive: true,
    filter(source) {
      const relative = path.relative(PROJECT_ROOT, source);
      if (relative === '') {
        return true;
      }
      const topLevel = relative.split(path.sep)[0];
      // GitHub Template 保留完整工作树；测试仅排除本地 Git 身份、依赖缓存和临时包产物。
      return !['.git', 'node_modules'].includes(topLevel) && !relative.endsWith('.tgz');
    },
  });

  await runGit(root, ['init', '--quiet']);
  await runGit(root, ['config', 'user.name', 'Scaffold Tests']);
  await runGit(root, ['config', 'user.email', 'tester@example.invalid']);
  await runGit(root, ['config', 'commit.gpgsign', 'false']);
  await runGit(root, ['add', '--all']);
  await runGit(root, ['commit', '--quiet', '--no-verify', '-m', 'Initial scaffold baseline']);
  await runGit(root, ['remote', 'add', 'origin', ORIGIN]);
  return root;
}

async function snapshotTree(root) {
  const snapshot = [];

  async function visit(directory, prefix = '') {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        snapshot.push([relativePath, 'directory']);
        await visit(target, relativePath);
      } else if (entry.isSymbolicLink()) {
        snapshot.push([relativePath, 'link', await readlink(target)]);
      } else {
        snapshot.push([relativePath, 'file', await readFile(target)]);
      }
    }
  }

  await visit(root);
  return snapshot;
}

async function transactionArtifacts(root) {
  const artifacts = [];

  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(target);
      } else if (
        entry.name === '.scaffold-init.lock'
        || entry.name.includes('.stage')
        || entry.name.includes('.backup')
        || entry.name.includes('.detached')
      ) {
        artifacts.push(path.relative(root, target));
      }
    }
  }

  await visit(root);
  return artifacts.sort();
}

function options(license, dryRun = false) {
  return {
    name: `example-${license.toLowerCase().replace(/[^a-z0-9]+/gu, '-')}`,
    description: `Create a complete ${license} example skill`,
    license,
    dryRun,
  };
}

function initializationContext(root, transactionFaults) {
  return {
    root,
    now: () => FIXED_NOW,
    transactionFaults,
  };
}

async function readJson(root, relativePath) {
  return JSON.parse(await readFile(path.join(root, ...splitRelative(relativePath)), 'utf8'));
}

function assertPackageLockConsistency(pkg, lock) {
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].name, pkg.name);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(lock.packages[''].description, pkg.description);
  assert.equal(lock.packages[''].license, pkg.license);
  assert.deepEqual(lock.packages[''].engines, pkg.engines);
}

sourceTest('npm ci succeeds and dry-run preserves every directory and byte', async (t) => {
  const root = await createSourceRepository(t);
  await runNpm(root, ['ci', '--ignore-scripts']);
  const before = await snapshotTree(root);

  const result = await initializeSkill(
    options('Apache-2.0', true),
    initializationContext(root, {
      stage() {
        throw new Error('dry-run must not start a transaction');
      },
    }),
  );

  assert.equal(result.status, 'dry-run');
  assert.deepEqual(await snapshotTree(root), before);
});

sourceTest('all licenses initialize, validate, remain idempotent, and preserve Git config', async (t) => {
  for (const license of ['Apache-2.0', 'MIT', 'UNLICENSED']) {
    await t.test(license, async (st) => {
      const root = await createSourceRepository(st);
      await runNpm(root, ['ci', '--ignore-scripts']);
      const configPath = path.join(root, '.git', 'config');
      const configBefore = await readFile(configPath);
      const selectedOptions = options(license);

      const result = await initializeSkill(selectedOptions, initializationContext(root));
      assert.equal(result.status, 'initialized');

      const pkg = await readJson(root, 'package.json');
      const lock = await readJson(root, 'package-lock.json');
      assert.equal(pkg.license, license);
      assertPackageLockConsistency(pkg, lock);
      if (license === 'UNLICENSED') {
        await assert.rejects(() => lstat(path.join(root, 'LICENSE')), { code: 'ENOENT' });
      } else {
        const licenseText = await readFile(path.join(root, 'LICENSE'), 'utf8');
        assert.match(licenseText, license === 'MIT' ? /MIT License/u : /Apache License/u);
      }

      const initialized = await snapshotTree(root);
      const repeated = await initializeSkill(selectedOptions, {
        ...initializationContext(root),
        now: () => new Date('2030-01-01T00:00:00.000Z'),
      });
      assert.deepEqual(repeated, { status: 'already-initialized', files: [], warnings: [] });
      assert.deepEqual(await snapshotTree(root), initialized);
      assert.equal((await readFile(configPath)).equals(configBefore), true);

      await runNpm(root, ['run', license === 'Apache-2.0' ? 'check' : 'validate']);
      await runNpm(root, ['run', 'audit']);
    });
  }
});

sourceTest('commit failure rolls back all writes and leaves no transaction artifacts', async (t) => {
  const root = await createSourceRepository(t);
  const before = await snapshotTree(root);
  const committedTargets = [];

  await assert.rejects(
    () => initializeSkill(options('Apache-2.0'), initializationContext(root, {
      commit({ target }) {
        committedTargets.push(target);
        if (target === 'docs/delivery-report.md') {
          throw new Error('injected end-to-end commit failure');
        }
      },
    })),
    /injected end-to-end commit failure/u,
  );

  assert.ok(committedTargets.length > 1);
  assert.deepEqual(await snapshotTree(root), before);
  assert.deepEqual(await transactionArtifacts(root), []);
});

sourceTest('unmanaged output collisions reject without writing', async (t) => {
  const cases = [
    ['SKILL.md', async (root) => writeFile(path.join(root, 'SKILL.md'), 'unmanaged skill\n')],
    [
      'docs/skill-brief.md',
      async (root) => writeFile(path.join(root, 'docs', 'skill-brief.md'), 'unmanaged brief\n'),
    ],
    ['LICENSE', async (root) => writeFile(path.join(root, 'LICENSE'), 'unmanaged license\n')],
  ];

  for (const [target, arrange] of cases) {
    await t.test(target, async (st) => {
      const root = await createSourceRepository(st);
      await arrange(root);
      const before = await snapshotTree(root);

      await assert.rejects(
        () => initializeSkill(options('Apache-2.0'), initializationContext(root)),
        /conflict|license|marker|owned|source/iu,
      );

      assert.deepEqual(await snapshotTree(root), before);
      assert.deepEqual(await transactionArtifacts(root), []);
    });
  }
});

sourceTest('fresh initialization fails the delivery gate while contracts are draft', async (t) => {
  const root = await createSourceRepository(t);
  await initializeSkill({
    ...options('Apache-2.0'),
    name: 'exampleskill',
  }, initializationContext(root));

  const result = spawnSync(process.execPath, [DELIVERY_SCRIPT], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  });

  assert.equal(result.status, 1, outputMessage(result));
  assert.match(result.stdout, /ERROR GATE_STATE_NOT_READY /u);
  assert.match(result.stdout, /ERROR GATE_BRIEF_NOT_READY /u);
  assert.equal(result.stderr, '');
});

sourceTest('repository contract tests support a fully copied initialized template', async (t) => {
  const root = await createSourceRepository(t);
  await initializeSkill(options('Apache-2.0'), initializationContext(root));

  await run(process.execPath, ['--test', 'tests/repository.test.js'], root);
});

sourceTest('complete-skill fixture passes the delivery gate from an independent copy', async (t) => {
  const parent = await mkdtemp(path.join(tmpdir(), 'skill-scaffold-complete-e2e-'));
  const root = path.join(parent, 'complete-skill');
  t.after(() => rm(parent, { recursive: true, force: true }));
  await cp(COMPLETE_FIXTURE, root, { recursive: true });

  const result = spawnSync(process.execPath, [DELIVERY_SCRIPT], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  });

  assert.equal(result.status, 0, outputMessage(result));
  assert.match(result.stdout, /^EVIDENCE pass REQ-001 /mu);
  assert.equal(result.stderr, '');
});
