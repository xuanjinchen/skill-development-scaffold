import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { auditRepository } from '../src/audit.js';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const AUDIT_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'audit.js');

function run(root, command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    ...options,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function git(root, args, options) {
  return run(root, 'git', args, options);
}

async function writeText(root, relativePath, content) {
  const target = path.join(root, ...relativePath.split('/'));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

async function createRepository(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'scaffold-audit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, ['init', '--quiet']);
  git(root, ['config', 'user.name', 'Fixture Tester']);
  git(root, ['config', 'user.email', 'tester@example.invalid']);
  await writeText(root, 'README.md', '# Fixture\n');
  await writeText(root, 'index.js', 'export const ready = true;\n');
  await writeText(root, 'package.json', `${JSON.stringify({
    name: 'audit-fixture',
    version: '1.0.0',
    private: true,
    type: 'module',
    files: ['README.md'],
  }, null, 2)}\n`);
  git(root, ['add', '.']);
  git(root, ['commit', '--quiet', '-m', 'test: create fixture']);
  return root;
}

function issueKeys(report) {
  return new Set(report.issues.map(({ code, location }) => `${code}:${location}`));
}

function highConfidenceCredentialEntries() {
  return [
    ['stripe-token.js', `sk_live_${'A'.repeat(32)}`],
    ['slack-bot-token.js', `xoxb-${'1'.repeat(12)}-${'2'.repeat(12)}-${'B'.repeat(24)}`],
    ['slack-user-token.js', `xoxp-${'3'.repeat(12)}-${'4'.repeat(12)}-${'C'.repeat(24)}`],
    ['google-api-key.js', `AIza${'D'.repeat(34)}-`],
    ['gitlab-token.js', `glpat-${'E'.repeat(23)}-`],
  ];
}

test('accepts a clean repository and explicit public email examples', async (t) => {
  const root = await createRepository(t);
  git(root, ['config', 'user.email', '41898282+fixture-bot@users.noreply.github.com']);
  await writeText(
    root,
    'index.js',
    'export const fixturePath = "C:/outside.txt";\n',
  );
  git(root, ['add', 'index.js']);
  git(root, ['commit', '--quiet', '-m', 'test: allow GitHub noreply identity']);
  git(root, [
    '-c', 'user.name=GitHub',
    '-c', 'user.email=noreply@github.com',
    'commit', '--quiet', '--allow-empty', '-m', 'test: allow GitHub merge identity',
  ]);

  const report = await auditRepository(root);

  assert.deepEqual(report.issues, []);
});

test('finds credentials in tracked worktree content without exposing the value', async (t) => {
  const root = await createRepository(t);
  const secret = ['ghp', 'A'.repeat(36)].join('_');
  await writeText(root, 'index.js', `export const credential = "${secret}";\n`);

  const report = await auditRepository(root);
  const serialized = JSON.stringify(report);

  assert.ok(issueKeys(report).has('CREDENTIAL_DETECTED:worktree:index.js'));
  assert.doesNotMatch(serialized, new RegExp(secret, 'u'));
});

test('finds common credential formats independently without exposing their values', async (t) => {
  const root = await createRepository(t);
  const credentials = new Map([
    ['npm-token.js', `npm_${'A'.repeat(36)}`],
    ['bearer.js', `Authorization: Bearer ${'b'.repeat(32)}`],
    ['client-secret.js', `client_secret=${'C'.repeat(32)}`],
    ['aws-session.js', `ASIA${'D1'.repeat(8)}`],
    ...highConfidenceCredentialEntries(),
  ]);
  for (const [filename, credential] of credentials) {
    await writeText(root, filename, `export const fixture = ${JSON.stringify(credential)};\n`);
    git(root, ['add', filename]);
  }

  const report = await auditRepository(root);
  const keys = issueKeys(report);
  const serialized = JSON.stringify(report);

  for (const [filename, credential] of credentials) {
    assert.ok(
      keys.has(`CREDENTIAL_DETECTED:worktree:${filename}`),
      `missing credential finding for ${filename}`,
    );
    assert.doesNotMatch(serialized, new RegExp(credential, 'u'));
  }
});

test('reuses credential detection for removed history and actual package content', async (t) => {
  const root = await createRepository(t);
  const credentials = highConfidenceCredentialEntries();
  const historicalBlobs = new Map();

  for (const [filename, credential] of credentials) {
    const historyPath = `history/${filename}`;
    await writeText(root, historyPath, `export const fixture = ${JSON.stringify(credential)};\n`);
    git(root, ['add', historyPath]);
  }
  git(root, ['commit', '--quiet', '-m', 'test: add credential detection fixtures']);
  for (const [filename] of credentials) {
    const historyPath = `history/${filename}`;
    historicalBlobs.set(filename, git(root, ['rev-parse', `HEAD:${historyPath}`]));
  }
  await rm(path.join(root, 'history'), { recursive: true });
  git(root, ['add', '-u']);
  git(root, ['commit', '--quiet', '-m', 'test: remove credential detection fixtures']);

  for (const [filename, credential] of credentials) {
    await writeText(root, `src/${filename}`, `export const fixture = ${JSON.stringify(credential)};\n`);
  }
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  pkg.files = ['README.md', 'src'];
  await writeText(root, 'package.json', `${JSON.stringify(pkg, null, 2)}\n`);

  const report = await auditRepository(root);
  const keys = issueKeys(report);
  const serialized = JSON.stringify(report);

  for (const [filename, credential] of credentials) {
    assert.ok(
      keys.has(`CREDENTIAL_DETECTED:history:${historicalBlobs.get(filename).slice(0, 12)}`),
      `missing history credential finding for ${filename}`,
    );
    assert.ok(
      keys.has(`CREDENTIAL_DETECTED:package:src/${filename}`),
      `missing package credential finding for ${filename}`,
    );
    assert.doesNotMatch(serialized, new RegExp(credential, 'u'));
  }
});

test('scans untracked files that npm actually packs', async (t) => {
  const root = await createRepository(t);
  const secret = `npm_${'E'.repeat(36)}`;
  await writeText(root, 'src/untracked.js', `export const credential = ${JSON.stringify(secret)};\n`);
  await writeText(root, 'src/credentials.json', '{}\n');
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  pkg.files = ['README.md', 'src'];
  await writeText(root, 'package.json', `${JSON.stringify(pkg, null, 2)}\n`);

  const report = await auditRepository(root);
  const keys = issueKeys(report);
  const serialized = JSON.stringify(report);

  assert.ok(keys.has('CREDENTIAL_DETECTED:package:src/untracked.js'));
  assert.ok(keys.has('SENSITIVE_FILENAME:package:src/credentials.json'));
  assert.doesNotMatch(serialized, new RegExp(secret, 'u'));
});

test('finds removed history secrets, private paths, sensitive files, and private emails', async (t) => {
  const root = await createRepository(t);
  const accessKey = ['AKIA', 'A1B2C3D4E5F6G7H8'].join('');
  const privatePath = ['C:', 'Users', 'private-owner', 'work', 'project'].join('/');
  await writeText(
    root,
    'credentials.json',
    `${JSON.stringify({ accessKey, workspace: privatePath })}\n`,
  );
  git(root, ['add', 'credentials.json']);
  git(root, [
    '-c', 'user.name=Private Developer',
    '-c', 'user.email=developer@private-company.test',
    'commit', '--quiet', '-m', 'test: add removed sensitive fixture',
  ]);
  await rm(path.join(root, 'credentials.json'));
  git(root, ['add', '-u']);
  git(root, ['commit', '--quiet', '-m', 'test: remove sensitive fixture']);

  const report = await auditRepository(root);
  const codes = new Set(report.issues.map(({ code }) => code));
  const serialized = JSON.stringify(report);

  for (const code of [
    'CREDENTIAL_DETECTED',
    'PRIVATE_PATH_DETECTED',
    'SENSITIVE_FILENAME',
    'PRIVATE_EMAIL',
  ]) {
    assert.ok(codes.has(code), `missing ${code}`);
  }
  assert.doesNotMatch(serialized, new RegExp(accessKey, 'u'));
  assert.doesNotMatch(serialized, /private-owner|private-company/iu);
});

test('scans commit messages and annotated tag metadata without exposing secrets', async (t) => {
  const root = await createRepository(t);
  const commitSecret = `npm_${'F'.repeat(36)}`;
  const tagSecret = `Authorization: Bearer ${'g'.repeat(32)}`;
  git(root, ['commit', '--quiet', '--allow-empty', '-m', `test: ${commitSecret}`]);
  const commitId = git(root, ['rev-parse', 'HEAD']);
  git(root, [
    '-c', 'user.name=Private Tagger',
    '-c', 'user.email=tagger@private-company.test',
    'tag', '-a', 'v1.0.0', '-m', tagSecret,
  ]);
  const tagId = git(root, ['rev-parse', 'v1.0.0']);

  const report = await auditRepository(root);
  const keys = issueKeys(report);
  const serialized = JSON.stringify(report);

  assert.ok(keys.has(`CREDENTIAL_DETECTED:commit:${commitId.slice(0, 12)}:message`));
  assert.ok(keys.has(`CREDENTIAL_DETECTED:tag:${tagId.slice(0, 12)}:message`));
  assert.ok(keys.has(`PRIVATE_EMAIL:tag:${tagId.slice(0, 12)}:tagger`));
  assert.doesNotMatch(serialized, new RegExp(commitSecret, 'u'));
  assert.doesNotMatch(serialized, new RegExp(tagSecret, 'u'));
  assert.doesNotMatch(serialized, /private-company/iu);
});

test('allows only the explicit fixture email and valid GitHub noreply identities', async (t) => {
  const root = await createRepository(t);
  git(root, [
    '-c', 'user.name=Private Tester',
    '-c', 'user.email=tester@private-company.test',
    'commit', '--quiet', '--allow-empty', '-m', 'test: reject private tester address',
  ]);
  const privateTesterCommit = git(root, ['rev-parse', 'HEAD']);
  git(root, [
    '-c', 'user.name=Invalid Example',
    '-c', 'user.email=developer@example.invalid',
    'commit', '--quiet', '--allow-empty', '-m', 'test: reject arbitrary example address',
  ]);
  const invalidExampleCommit = git(root, ['rev-parse', 'HEAD']);

  const report = await auditRepository(root);
  const keys = issueKeys(report);

  assert.ok(keys.has(`PRIVATE_EMAIL:commit:${privateTesterCommit.slice(0, 12)}:author`));
  assert.ok(keys.has(`PRIVATE_EMAIL:commit:${invalidExampleCommit.slice(0, 12)}:author`));
});

test('detects dangerous tracked links from the Git index on every platform', async (t) => {
  const root = await createRepository(t);
  const target = Buffer.from('../../outside');
  const objectId = git(root, ['hash-object', '-w', '--stdin'], { input: target });
  git(root, ['update-index', '--add', '--cacheinfo', `120000,${objectId},escape-link`]);

  const report = await auditRepository(root);

  assert.ok(issueKeys(report).has('DANGEROUS_LINK:worktree:escape-link'));
});

test('rejects unsafe and non-whitelisted package entries deterministically', async (t) => {
  const root = await createRepository(t);
  const report = await auditRepository(root, {
    packEntries: [
      { path: 'package/CHANGELOG.md' },
      { path: 'package/README.md' },
      { path: 'package/tests/secret.test.js' },
      { path: 'package/.scaffold/state.json' },
      { path: 'package/eval-workspaces/run/output.json' },
      { path: 'package/docs/.scaffold/state.json' },
      { path: 'package/src/eval-workspaces/output.json' },
      { path: 'package/docs/.brief.md.00000000-0000-4000-8000-000000000000.0.stage' },
      { path: 'package/src/.audit.js.00000000-0000-4000-8000-000000000000.backup' },
      { path: 'package/.scaffold-init.lock.00000000-0000-4000-8000-000000000000.lock-recovery-detached' },
      { path: 'package/debug.log' },
      { path: 'package/credentials.json' },
      { path: 'package/../outside.txt' },
      { path: 'package/src/linked.js', type: 'symlink', linkPath: '../../outside.js' },
    ],
  });
  const keys = issueKeys(report);

  assert.equal(keys.has('PACKAGE_FILE_FORBIDDEN:package:CHANGELOG.md'), false);
  assert.ok(keys.has('PACKAGE_FILE_FORBIDDEN:package:tests/secret.test.js'));
  assert.ok(keys.has('PACKAGE_FILE_FORBIDDEN:package:.scaffold/state.json'));
  assert.ok(keys.has('PACKAGE_FILE_FORBIDDEN:package:eval-workspaces/run/output.json'));
  assert.ok(keys.has('PACKAGE_FILE_FORBIDDEN:package:docs/.scaffold/state.json'));
  assert.ok(keys.has('PACKAGE_FILE_FORBIDDEN:package:src/eval-workspaces/output.json'));
  assert.ok(keys.has('PACKAGE_FILE_FORBIDDEN:package:docs/.brief.md.00000000-0000-4000-8000-000000000000.0.stage'));
  assert.ok(keys.has('PACKAGE_FILE_FORBIDDEN:package:src/.audit.js.00000000-0000-4000-8000-000000000000.backup'));
  assert.ok(keys.has('PACKAGE_FILE_FORBIDDEN:package:.scaffold-init.lock.00000000-0000-4000-8000-000000000000.lock-recovery-detached'));
  assert.ok(keys.has('PACKAGE_FILE_FORBIDDEN:package:debug.log'));
  assert.ok(keys.has('SENSITIVE_FILENAME:package:credentials.json'));
  assert.ok(keys.has('PACKAGE_PATH_UNSAFE:package:<redacted>'));
  assert.ok(keys.has('PACKAGE_LINK:package:src/linked.js'));
});

test('rejects non-portable npm archive paths', async (t) => {
  const root = await createRepository(t);
  const cases = [
    ['NTFS alternate data stream', 'package/src/file:ads.js'],
    ['Windows device name with extension', 'package/src/CON.txt'],
    ['Windows device name ignoring case', 'package/src/aux.JSON'],
    ['Windows console input device', 'package/src/CONIN$.js'],
    ['Windows COM superscript digit device', 'package/src/COM¹.txt'],
    ['Windows COM second superscript digit device', 'package/src/COM².txt'],
    ['Windows LPT third superscript digit device', 'package/src/LPT³.js'],
    ['Windows-invalid punctuation', 'package/src/result?.js'],
    ['segment ending in a dot', 'package/src/report.'],
    ['segment ending in a space', 'package/src/report '],
    ['backslash separator', 'package/src\\windows.js'],
    ['duplicate separator', 'package/src//double.js'],
    ['dot segment', 'package/src/./dot.js'],
  ];

  for (const [name, entryPath] of cases) {
    await t.test(name, async () => {
      const report = await auditRepository(root, {
        packEntries: [{ path: entryPath, type: 'file', content: Buffer.alloc(0) }],
      });

      assert.ok(
        issueKeys(report).has('PACKAGE_PATH_UNSAFE:package:<redacted>'),
        `accepted unsafe package path: ${entryPath}`,
      );
    });
  }
});

test('CLI emits stable redacted issues and exits with one for findings', async (t) => {
  const root = await createRepository(t);
  const secret = ['github_pat', 'A'.repeat(22), 'B'.repeat(59)].join('_');
  await writeText(root, 'index.js', `export const credential = "${secret}";\n`);

  const result = spawnSync(process.execPath, [AUDIT_SCRIPT], {
    cwd: root,
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /^ERROR CREDENTIAL_DETECTED worktree:index\.js\n$/mu);
  assert.equal(result.stderr, '');
  assert.doesNotMatch(result.stdout, new RegExp(secret, 'u'));
  assert.doesNotMatch(result.stdout, /\n\s+at /u);
});

test('audit does not modify tracked repository files', async (t) => {
  const root = await createRepository(t);
  const before = await readFile(path.join(root, 'package.json'));

  await auditRepository(root);

  assert.equal((await readFile(path.join(root, 'package.json'))).equals(before), true);
  assert.equal(git(root, ['status', '--porcelain']), '');
});
