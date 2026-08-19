import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const REPOSITORY_MODE = JSON.parse(
  await readFile(path.join(PROJECT_ROOT, 'package.json'), 'utf8'),
).scaffold.mode;
const sourceTest = REPOSITORY_MODE === 'source' ? test : test.skip;

async function source(relativePath) {
  return readFile(path.join(PROJECT_ROOT, ...relativePath.split('/')), 'utf8');
}

function npmCommand(args) {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean);
  const cli = candidates.find((candidate) => existsSync(candidate));
  return cli === undefined
    ? { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', args }
    : { command: process.execPath, args: [cli, ...args] };
}

test('package metadata exposes the deterministic audit without publishing local data', async () => {
  const pkg = JSON.parse(await source('package.json'));

  assert.equal(pkg.scripts.audit, 'node scripts/audit.js');
  assert.deepEqual(pkg.files, pkg.scaffold.mode === 'source'
    ? [
      'AGENTS.md',
      'CHANGELOG.md',
      'CONTRIBUTING.md',
      'LICENSE',
      'README.md',
      'SECURITY.md',
      'docs',
      'scripts',
      'src',
      'templates',
    ]
    : ['SKILL.md']);
  for (const forbidden of ['tests', '.scaffold', 'evals', 'eval-workspaces']) {
    assert.equal(pkg.files.includes(forbidden), false);
  }
});

test('maintenance CLIs use the shared closed-pipe output protocol', async () => {
  for (const relativePath of ['scripts/audit.js', 'scripts/validate.js', 'src/recover-lock.js']) {
    const script = await source(relativePath);
    assert.match(script, /writeOutput/u, relativePath);
  }
});

test('CI uses one read-only three-platform Node 22 matrix with pinned Actions', async () => {
  const workflow = await source('.github/workflows/ci.yml');

  assert.match(workflow, /^permissions:\n  contents: read$/mu);
  assert.match(workflow, /fail-fast: false/u);
  for (const platform of ['windows-latest', 'macos-latest', 'ubuntu-latest']) {
    assert.match(workflow, new RegExp(`\\b${platform}\\b`, 'u'));
  }
  assert.match(workflow, /node-version: 22/u);
  assert.match(workflow, /cache-dependency-path: package-lock\.json/u);
  assert.match(workflow, /fetch-depth: 0/u);
  assert.match(workflow, /run: npm ci --ignore-scripts/u);
  assert.match(workflow, /run: npm run check/u);
  assert.match(workflow, /run: npm run audit/u);

  const actionUses = [...workflow.matchAll(/^\s*- uses: ([^\s#]+)(?:\s+#\s*(\S+))?$/gmu)];
  assert.equal(actionUses.length, 2);
  for (const [, action, version] of actionUses) {
    assert.match(action, /^actions\/(?:checkout|setup-node)@[0-9a-f]{40}$/u);
    assert.match(version, /^v[0-9]+\.[0-9]+\.[0-9]+$/u);
  }
});

test('Dependabot covers npm and GitHub Actions', async () => {
  const dependabot = await source('.github/dependabot.yml');

  assert.match(dependabot, /package-ecosystem: "npm"/u);
  assert.match(dependabot, /package-ecosystem: "github-actions"/u);
  assert.equal((dependabot.match(/interval: "weekly"/gu) ?? []).length, 2);
});

test('Git ignores every transaction recovery artifact shape', () => {
  const uuid = '00000000-0000-4000-8000-000000000000';
  const artifacts = [
    `.README.md.${uuid}.0.stage`,
    `docs/.skill-brief.md.${uuid}.backup`,
    `src/.audit.js.${uuid}.rollback-detached`,
  ];

  for (const artifact of artifacts) {
    const result = spawnSync('git', ['check-ignore', '--quiet', '--', artifact], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `${artifact}: ${result.stderr}`);
  }
});

test('governance documents define public contribution and private reporting boundaries', async () => {
  const security = await source('SECURITY.md');
  const contributing = await source('CONTRIBUTING.md');

  assert.match(security, /Private Vulnerability Reporting/u);
  assert.match(security, /security\/advisories\/new/u);
  assert.doesNotMatch(security, /[A-Z0-9._%+-]+@(?!example\.invalid\b)[A-Z0-9.-]+\.[A-Z]{2,}/iu);

  for (const requirement of [
    /Node\.js 22/u,
    /Conventional Commits/u,
    /npm run check/u,
    /npm run audit/u,
    /model costs?/iu,
    /sensitive information/iu,
  ]) {
    assert.match(contributing, requirement);
  }
});

sourceTest('release documentation limits this repository to GitHub source archives', async () => {
  const changelog = await source('CHANGELOG.md');
  const readme = await source('README.md');
  const usage = await source('docs/scaffold-usage.md');
  const pkg = JSON.parse(await source('package.json'));

  assert.equal(pkg.private, true);
  assert.match(changelog, /^# Changelog\n/u);
  assert.match(changelog, /^## \[0\.1\.0\] - 2026-08-19$/mu);
  assert.match(readme, /GitHub.*source archives|GitHub.*源码归档/iu);
  assert.match(usage, /npm pack.*内部.*白名单/iu);
  assert.match(usage, /不发布.*npm|npm.*不发布/iu);
  assert.match(usage, /不上传.*自定义.*Release.*资产/iu);
});

test('issue and pull request templates collect reproducibility and safety evidence', async () => {
  const issue = await source('.github/ISSUE_TEMPLATE/bug_report.yml');
  const pullRequest = await source('.github/pull_request_template.md');

  for (const requirement of [/reproduction/iu, /platform/iu, /validation/iu, /compatibility/iu]) {
    assert.match(issue, requirement);
  }
  for (const requirement of [/npm run check/u, /npm run audit/u, /compatibility/iu, /secret review/iu]) {
    assert.match(pullRequest, requirement);
  }
});

test('npm dry-run package stays inside the current mode whitelist', async () => {
  const invocation = npmCommand(['pack', '--json', '--dry-run', '--ignore-scripts']);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const [pack] = JSON.parse(result.stdout);
  const entries = pack.files.map(({ path: entryPath }) => entryPath.replaceAll('\\', '/'));
  const mode = JSON.parse(await source('package.json')).scaffold.mode;

  if (mode === 'source') {
    assert.ok(entries.includes('src/audit.js'));
    assert.ok(entries.includes('scripts/audit.js'));
    assert.ok(entries.includes('templates/project/SKILL.md.template'));
    assert.ok(entries.includes('docs/mature-skill-development-design.md'));
  } else {
    assert.ok(entries.includes('SKILL.md'));
    assert.equal(entries.some((entry) => /^(?:src|scripts|templates)(?:\/|$)/u.test(entry)), false);
  }
  assert.equal(entries.some((entry) => /^(?:tests|\.scaffold|evals?|eval-workspaces)(?:\/|$)/u.test(entry)), false);
  assert.equal(entries.some((entry) => /(?:^|\/)(?:credentials?\.json|\.env(?:\.|$))|\.log$/iu.test(entry)), false);
});
