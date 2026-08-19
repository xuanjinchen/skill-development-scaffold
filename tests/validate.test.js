import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { validateRepository } from '../src/validate.js';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const VALIDATE_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'validate.js');
const SOURCE_FILES = [
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
];
const REQUIRED_SOURCE_FILES = [
  'CHANGELOG.md',
  'docs/mature-skill-development-design.md',
  'docs/mature-skill-development-plan.md',
  'docs/scaffold-usage.md',
  'scripts/audit.js',
  'scripts/delivery-gate.js',
  'scripts/init-skill.js',
  'scripts/recover-lock.js',
  'scripts/validate.js',
  'src/audit.js',
  'src/cli.js',
  'src/delivery-gate.js',
  'src/initialize.js',
  'src/output.js',
  'src/recover-lock.js',
  'src/state.js',
  'src/templates.js',
  'src/transaction.js',
  'src/validate.js',
  'templates/licenses/Apache-2.0.txt',
  'templates/licenses/MIT.txt',
  'templates/project/README.md.template',
  'templates/project/SKILL.md.template',
  'templates/project/decisions.md.template',
  'templates/project/delivery-report.md.template',
  'templates/project/evals.json.template',
  'templates/project/skill-brief.md.template',
];
const INITIAL_FILES = [
  'LICENSE',
  'README.md',
  'SKILL.md',
  'docs/decisions.md',
  'docs/delivery-report.md',
  'docs/skill-brief.md',
  'evals/evals.json',
  'package-lock.json',
  'package.json',
];
const SKILL = {
  name: 'example-skill',
  description: 'Create consistent example outputs',
  license: 'Apache-2.0',
};

function packageJson(mode = 'source', skill = SKILL) {
  return {
    name: mode === 'source' ? 'skill-development-scaffold' : skill.name,
    version: '0.1.0',
    description: mode === 'source'
      ? 'Executable Node.js scaffold for developing mature Agent Skills.'
      : skill.description,
    private: true,
    type: 'module',
    engines: { node: '>=22' },
    scripts: {
      'init:skill': 'node scripts/init-skill.js',
      'recover:lock': 'node scripts/recover-lock.js',
      test: 'node --test',
      validate: 'node scripts/validate.js',
      audit: 'node scripts/audit.js',
      check: 'npm test && npm run validate',
      'gate:delivery': 'node scripts/delivery-gate.js',
    },
    files: mode === 'source' ? SOURCE_FILES : ['SKILL.md'],
    license: skill.license,
    scaffold: { mode, version: '0.1.0' },
  };
}

function lockJson(packageValue) {
  return {
    name: packageValue.name,
    version: packageValue.version,
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': {
        name: packageValue.name,
        version: packageValue.version,
        license: packageValue.license,
        engines: packageValue.engines,
      },
    },
  };
}

async function writeText(root, relativePath, content) {
  const target = path.join(root, ...relativePath.split('/'));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

async function canonicalLicense(id, initializedAt = '2026-08-19') {
  const filename = id === 'MIT' ? 'MIT.txt' : 'Apache-2.0.txt';
  const source = await readFile(path.join(PROJECT_ROOT, 'templates', 'licenses', filename), 'utf8');
  return id === 'MIT'
    ? source.replace('{{INITIALIZED_DATE}}', initializedAt.slice(0, 4))
    : source;
}

async function createSourceFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'validate-source-'));
  const pkg = packageJson();
  await writeText(root, 'package.json', `${JSON.stringify(pkg, null, 2)}\n`);
  await writeText(root, 'package-lock.json', `${JSON.stringify(lockJson(pkg), null, 2)}\n`);
  await writeText(
    root,
    'README.md',
    '<!-- skill-development-scaffold:source -->\n# Skill Development Scaffold\n',
  );

  for (const relativePath of REQUIRED_SOURCE_FILES) {
    if (relativePath === 'templates/licenses/Apache-2.0.txt') {
      await writeText(root, relativePath, await canonicalLicense('Apache-2.0'));
    } else if (relativePath === 'templates/licenses/MIT.txt') {
      const source = await readFile(
        path.join(PROJECT_ROOT, 'templates', 'licenses', 'MIT.txt'),
        'utf8',
      );
      await writeText(root, relativePath, source);
    } else {
      await writeText(root, relativePath, `fixture for ${relativePath}\n`);
    }
  }
  await writeText(root, 'src/scaffold.js', 'export const scaffold = true;\n');
  for (const relativePath of ['AGENTS.md', 'CONTRIBUTING.md', 'SECURITY.md']) {
    await writeText(root, relativePath, `fixture for ${relativePath}\n`);
  }
  await writeText(root, 'LICENSE', await canonicalLicense('Apache-2.0'));
  return root;
}

function briefContract() {
  return {
    schema_version: 1,
    status: 'draft',
    conflicts: [],
    acceptance_criteria: [],
    tracks: Object.fromEntries([
      'references',
      'scripts',
      'assets',
      'implicit-trigger',
      'multi-agent',
      'installer',
      'open-source-release',
    ].map((track) => [track, {
      status: 'disabled',
      evidence: `Disabled ${track}`,
      unblock_condition: '',
    }])),
    prompt_budget: {
      limit_tokens: null,
      measured_tokens: null,
      evidence: '',
    },
  };
}

function contractDocument(title, marker, value) {
  return `# ${title}\n\n${marker}\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;
}

function decision(id, supersedes = null) {
  return {
    id,
    status: 'active',
    scope: `Scope for ${id}`,
    decision: `Decision for ${id}`,
    evidence: `Evidence for ${id}`,
    supersedes,
  };
}

function evaluation(id, prompt, assertions = [{ id: 'ASSERT-1', text: 'Expected behavior' }]) {
  return {
    id,
    category: 'positive',
    prompt,
    assertions,
    result: { status: 'not-run', evidence: '' },
  };
}

async function createInitializedFixture(overrides = {}) {
  const root = await createSourceFixture();
  const initializedAt = '2026-08-19';
  const skill = { ...SKILL, ...overrides };
  const pkg = packageJson('initialized', skill);
  await writeText(root, 'package.json', `${JSON.stringify(pkg, null, 2)}\n`);
  await writeText(root, 'package-lock.json', `${JSON.stringify(lockJson(pkg), null, 2)}\n`);
  await writeText(
    root,
    'SKILL.md',
    `---\nname: "${skill.name}"\ndescription: "${skill.description}"\n---\n\n# ${skill.name}\n`,
  );
  const renderedSkillName = skill.name.replaceAll('-', '\\-');
  await writeText(root, 'README.md', `# ${renderedSkillName}\n\nObjective: ${skill.description}\n`);
  await writeText(
    root,
    'docs/skill-brief.md',
    contractDocument(
      'Skill Brief',
      '<!-- scaffold-contract:skill-brief:v1 -->',
      briefContract(),
    ),
  );
  await writeText(
    root,
    'docs/decisions.md',
    contractDocument(
      'Decisions',
      '<!-- scaffold-contract:decisions:v1 -->',
      { schema_version: 1, decisions: [] },
    ),
  );
  await writeText(
    root,
    'docs/delivery-report.md',
    contractDocument(
      'Delivery Report',
      '<!-- scaffold-contract:delivery-report:v1 -->',
      { schema_version: 1, requirements: [], capability_claims: [] },
    ),
  );
  await writeText(
    root,
    'evals/evals.json',
    `${JSON.stringify({ schema_version: 1, skill: skill.name, evals: [] }, null, 2)}\n`,
  );

  if (skill.license === 'UNLICENSED') {
    await rm(path.join(root, 'LICENSE'));
  } else {
    await writeText(root, 'LICENSE', await canonicalLicense(skill.license, initializedAt));
  }

  const targets = skill.license === 'UNLICENSED'
    ? INITIAL_FILES.filter((target) => target !== 'LICENSE')
    : INITIAL_FILES;
  const initialFiles = {};
  for (const target of targets) {
    initialFiles[target] = createHash('sha256')
      .update(await readFile(path.join(root, ...target.split('/'))))
      .digest('hex');
  }
  await writeText(
    root,
    '.scaffold/state.json',
    `${JSON.stringify({
      schema_version: 1,
      scaffold_version: '0.1.0',
      status: 'draft',
      skill,
      initialized_at: initializedAt,
      initial_files: initialFiles,
    }, null, 2)}\n`,
  );
  return root;
}

function issueCodes(issues) {
  return new Set(issues.map(({ code }) => code));
}

async function snapshot(root) {
  const entries = new Map();

  async function visit(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(target, relativePath);
      } else {
        entries.set(relativePath, await readFile(target));
      }
    }
  }

  await visit(root);
  return entries;
}

test('accepts a valid source repository', async () => {
  const root = await createSourceFixture();
  const report = await validateRepository(root);

  assert.equal(report.mode, 'source');
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.warnings, []);
});

test('requires completed governance files and executable command sources', async () => {
  const root = await createSourceFixture();
  await rm(path.join(root, 'AGENTS.md'));
  await rm(path.join(root, 'scripts', 'audit.js'));

  const report = await validateRepository(root);
  const missingPaths = new Set(
    report.errors
      .filter(({ code }) => code === 'SOURCE_FILE_MISSING')
      .map(({ path: issuePath }) => issuePath),
  );
  assert.ok(missingPaths.has('AGENTS.md'));
  assert.ok(missingPaths.has('scripts/audit.js'));
});

test('reports source ownership, required file, lock, license, and publish issues', async () => {
  const root = await createSourceFixture();
  await writeText(root, 'SKILL.md', '# unmanaged\n');
  await writeText(root, '.scaffold/state.json', '{}\n');
  await rm(path.join(root, 'templates', 'project', 'README.md.template'));
  const pkg = packageJson();
  pkg.files = ['src', '../outside'];
  await writeText(root, 'package.json', `${JSON.stringify(pkg, null, 2)}\n`);
  await writeText(root, 'package-lock.json', `${JSON.stringify(lockJson({ ...pkg, version: '9.9.9' }), null, 2)}\n`);
  await writeText(root, 'LICENSE', 'changed\n');

  const codes = issueCodes((await validateRepository(root)).errors);
  for (const code of [
    'SOURCE_SKILL_PRESENT',
    'SOURCE_STATE_PRESENT',
    'SOURCE_FILE_MISSING',
    'PACKAGE_LOCK_MISMATCH',
    'LICENSE_MISMATCH',
    'PUBLISH_PATH_UNSAFE',
    'PUBLISH_FILES_INVALID',
  ]) {
    assert.ok(codes.has(code), `missing ${code}`);
  }
});

test('rejects changed source maintenance commands', async () => {
  const root = await createSourceFixture();
  const pkg = packageJson();
  pkg.scripts.validate = 'node scripts/not-the-validator.js';
  await writeText(root, 'package.json', `${JSON.stringify(pkg, null, 2)}\n`);

  const report = await validateRepository(root);
  assert.ok(issueCodes(report.errors).has('SOURCE_PACKAGE_INVALID'));
});

test('rejects invalid UTF-8, BOM, NUL, and CRLF in source text files', async () => {
  const root = await createSourceFixture();
  await writeFile(path.join(root, 'README.md'), Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from('source\n'),
  ]));
  await writeFile(
    path.join(root, 'docs', 'mature-skill-development-design.md'),
    Buffer.from('contains\0nul\n'),
  );
  await writeFile(
    path.join(root, 'templates', 'project', 'SKILL.md.template'),
    Buffer.from('line one\r\nline two\r\n'),
  );
  await writeFile(path.join(root, 'scripts', 'init-skill.js'), Buffer.from([0xff, 0xfe]));

  const codes = issueCodes((await validateRepository(root)).errors);
  assert.ok(codes.has('TEXT_BOM'));
  assert.ok(codes.has('TEXT_NUL'));
  assert.ok(codes.has('TEXT_CRLF'));
  assert.ok(codes.has('TEXT_INVALID_UTF8'));
});

test('reports a reused file encoding issue only once', async () => {
  const root = await createSourceFixture();
  const templatePath = path.join(root, 'templates', 'licenses', 'Apache-2.0.txt');
  await writeFile(templatePath, Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    await readFile(templatePath),
  ]));

  const report = await validateRepository(root);
  assert.equal(report.errors.filter(({ code, path: issuePath }) =>
    code === 'TEXT_BOM' && issuePath === 'templates/licenses/Apache-2.0.txt').length, 1);
});

test('recursively validates every existing source publication text file', async () => {
  const root = await createSourceFixture();
  await writeFile(path.join(root, 'docs', 'nested-invalid.md'), Buffer.from([0xff]));
  await writeText(root, 'scripts/nested/tool.js', 'const value = 1;\0\n');
  await writeText(root, 'src/nested/module.js', 'line one\r\nline two\r\n');
  await writeFile(
    path.join(root, 'templates', 'nested.template'),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('template\n')]),
  );
  await writeText(root, 'CONTRIBUTING.md', 'first\r\nsecond\r\n');

  const report = await validateRepository(root);
  const issues = new Set(report.errors.map(({ code, path: issuePath }) => `${code}:${issuePath}`));
  for (const expected of [
    'TEXT_INVALID_UTF8:docs/nested-invalid.md',
    'TEXT_NUL:scripts/nested/tool.js',
    'TEXT_CRLF:src/nested/module.js',
    'TEXT_BOM:templates/nested.template',
    'TEXT_CRLF:CONTRIBUTING.md',
  ]) {
    assert.ok(issues.has(expected), `missing ${expected}`);
  }
});

test('accepts valid initialized repositories for every supported license', async () => {
  for (const license of ['Apache-2.0', 'MIT', 'UNLICENSED']) {
    const report = await validateRepository(await createInitializedFixture({ license }));
    assert.equal(report.mode, 'initialized');
    assert.deepEqual(report.errors, [], `${license}: ${JSON.stringify(report.errors)}`);
    assert.deepEqual(report.warnings, []);
  }
});

test('reports invalid state and package-lock metadata', async () => {
  const root = await createInitializedFixture();
  await writeText(root, '.scaffold/state.json', '{"schema_version":2}\n');
  const lock = lockJson(packageJson('initialized'));
  lock.packages[''].name = 'different-name';
  await writeText(root, 'package-lock.json', `${JSON.stringify(lock, null, 2)}\n`);

  const codes = issueCodes((await validateRepository(root)).errors);
  assert.ok(codes.has('STATE_INVALID'));
  assert.ok(codes.has('PACKAGE_LOCK_MISMATCH'));
});

test('validates initialized frontmatter, README, contracts, JSON, and tokens', async () => {
  const root = await createInitializedFixture();
  await writeText(
    root,
    'SKILL.md',
    '---\nname: example-skill\nname: duplicate\ndescription: broken\n---\n',
  );
  await writeText(root, 'README.md', '# wrong-name\n\n{{SKILL_NAME}}\n');
  await writeText(
    root,
    'docs/skill-brief.md',
    contractDocument(
      'Skill Brief',
      '<!-- scaffold-contract:skill-brief:v1 -->',
      { ...briefContract(), unknown: true },
    ),
  );
  await writeText(
    root,
    'docs/decisions.md',
    contractDocument(
      'Decisions',
      '<!-- scaffold-contract:decisions:v1 -->',
      { schema_version: 1, decisions: 'not-an-array' },
    ),
  );
  await writeText(
    root,
    'docs/delivery-report.md',
    '# Delivery\n\n<!-- scaffold-contract:delivery-report:v1 -->\nnot-json\n',
  );
  await writeText(root, 'evals/evals.json', '{\n');

  const codes = issueCodes((await validateRepository(root)).errors);
  for (const code of [
    'SKILL_FRONTMATTER_INVALID',
    'README_NAME_MISMATCH',
    'BRIEF_CONTRACT_INVALID',
    'DECISIONS_CONTRACT_INVALID',
    'DELIVERY_CONTRACT_INVALID',
    'EVALS_CONTRACT_INVALID',
    'TOKEN_UNRESOLVED',
  ]) {
    assert.ok(codes.has(code), `missing ${code}`);
  }
});

test('normalizes malformed evaluation entries into a stable issue', async () => {
  const root = await createInitializedFixture();
  await writeText(
    root,
    'evals/evals.json',
    `${JSON.stringify({ schema_version: 1, skill: SKILL.name, evals: [null] }, null, 2)}\n`,
  );

  const report = await validateRepository(root);
  assert.ok(issueCodes(report.errors).has('EVALS_CONTRACT_INVALID'));
});

test('requires an empty draft budget and a bounded measured budget', async () => {
  const cases = [
    {
      name: 'draft budget contains measurements',
      contract: {
        ...briefContract(),
        prompt_budget: { limit_tokens: 100, measured_tokens: 50, evidence: 'measured' },
      },
    },
    {
      name: 'ready measurement exceeds its limit',
      contract: {
        ...briefContract(),
        status: 'ready',
        prompt_budget: { limit_tokens: 100, measured_tokens: 101, evidence: 'measured' },
      },
    },
  ];

  for (const item of cases) {
    const root = await createInitializedFixture();
    await writeText(
      root,
      'docs/skill-brief.md',
      contractDocument(
        'Skill Brief',
        '<!-- scaffold-contract:skill-brief:v1 -->',
        item.contract,
      ),
    );
    const report = await validateRepository(root);
    assert.ok(issueCodes(report.errors).has('BRIEF_CONTRACT_INVALID'), item.name);
  }
});

test('requires decision supersedes references to be prior and acyclic', async () => {
  const validRoot = await createInitializedFixture();
  await writeText(
    validRoot,
    'docs/decisions.md',
    contractDocument(
      'Decisions',
      '<!-- scaffold-contract:decisions:v1 -->',
      { schema_version: 1, decisions: [decision('DEC-1'), decision('DEC-2', 'DEC-1')] },
    ),
  );
  assert.equal(
    issueCodes((await validateRepository(validRoot)).errors).has('DECISIONS_CONTRACT_INVALID'),
    false,
  );

  const invalidSets = [
    [decision('DEC-1', 'DEC-9')],
    [decision('DEC-1', 'DEC-2'), decision('DEC-2', 'DEC-1')],
  ];
  for (const decisions of invalidSets) {
    const root = await createInitializedFixture();
    await writeText(
      root,
      'docs/decisions.md',
      contractDocument(
        'Decisions',
        '<!-- scaffold-contract:decisions:v1 -->',
        { schema_version: 1, decisions },
      ),
    );
    assert.ok(
      issueCodes((await validateRepository(root)).errors).has('DECISIONS_CONTRACT_INVALID'),
    );
  }
});

test('requires unique long evaluation prompts and non-empty assertions', async () => {
  const longPrompt = 'Create a deterministic result for this complete evaluation request.';
  const invalidSets = [
    [evaluation('EVAL-1', 'too short')],
    [evaluation('EVAL-1', longPrompt, [])],
    [evaluation('EVAL-1', longPrompt), evaluation('EVAL-2', longPrompt)],
  ];

  for (const evals of invalidSets) {
    const root = await createInitializedFixture();
    await writeText(
      root,
      'evals/evals.json',
      `${JSON.stringify({ schema_version: 1, skill: SKILL.name, evals }, null, 2)}\n`,
    );
    assert.ok(issueCodes((await validateRepository(root)).errors).has('EVALS_CONTRACT_INVALID'));
  }
});

test('frontmatter accepts only JSON-quoted YAML string scalars', async () => {
  const invalidFrontmatter = [
    'name: example-skill\ndescription: "Create consistent example outputs"',
    'name: ["example-skill"]\ndescription: "Create consistent example outputs"',
    'name: {"value":"example-skill"}\ndescription: "Create consistent example outputs"',
  ];

  for (const frontmatter of invalidFrontmatter) {
    const root = await createInitializedFixture();
    await writeText(root, 'SKILL.md', `---\n${frontmatter}\n---\n\n# example-skill\n`);
    assert.ok(
      issueCodes((await validateRepository(root)).errors).has('SKILL_FRONTMATTER_INVALID'),
    );
  }
});

test('parses state from the bytes returned by the safe repository reader', async () => {
  const source = await readFile(path.join(PROJECT_ROOT, 'src', 'validate.js'), 'utf8');
  assert.doesNotMatch(source, /readScaffoldState/u);
  assert.match(source, /assertScaffoldState/u);

  const root = await createInitializedFixture();
  const statePath = path.join(root, '.scaffold', 'state.json');
  const stateSource = await readFile(statePath, 'utf8');
  await writeFile(
    statePath,
    stateSource.replace('"schema_version": 1,', '"schema_version": 1,\n  "schema_version": 1,'),
  );
  assert.ok(issueCodes((await validateRepository(root)).errors).has('STATE_INVALID'));
});

test('enforces initialized license presence and exact content', async () => {
  const mitRoot = await createInitializedFixture({ license: 'MIT' });
  await writeText(mitRoot, 'LICENSE', 'MIT License\nwrong owner\n');
  assert.ok(issueCodes((await validateRepository(mitRoot)).errors).has('LICENSE_MISMATCH'));

  const apacheRoot = await createInitializedFixture();
  await rm(path.join(apacheRoot, 'LICENSE'));
  assert.ok(
    issueCodes((await validateRepository(apacheRoot)).errors).has('INITIALIZED_FILE_MISSING'),
  );

  const unlicensedRoot = await createInitializedFixture({ license: 'UNLICENSED' });
  await writeText(unlicensedRoot, 'LICENSE', 'unexpected\n');
  assert.ok(issueCodes((await validateRepository(unlicensedRoot)).errors).has('LICENSE_UNEXPECTED'));
});

test('rejects initialized publish paths outside the closed whitelist', async () => {
  const root = await createInitializedFixture();
  const pkg = packageJson('initialized');
  pkg.files = ['SKILL.md', 'tests', 'evals', '.scaffold/state.json', 'C:/outside.txt'];
  await writeText(root, 'package.json', `${JSON.stringify(pkg, null, 2)}\n`);

  const codes = issueCodes((await validateRepository(root)).errors);
  assert.ok(codes.has('PUBLISH_PATH_UNSAFE'));
  assert.ok(codes.has('PUBLISH_FILES_INVALID'));
});

test('reports state digest drift as a warning without failing validation', async () => {
  const root = await createInitializedFixture();
  await writeText(
    root,
    'README.md',
    '# example\\-skill\n\nObjective: Create consistent example outputs\n\nMaintained later.\n',
  );

  const report = await validateRepository(root);
  assert.deepEqual(report.errors, []);
  assert.ok(issueCodes(report.warnings).has('STATE_DIGEST_DRIFT'));
});

test('validation does not mutate the repository', async () => {
  const root = await createInitializedFixture();
  await writeText(root, 'README.md', '# invalid\r\n');
  const before = await snapshot(root);

  await validateRepository(root);

  const after = await snapshot(root);
  assert.deepEqual(after, before);
});

test('CLI prints stable one-line issues and exits according to errors', async () => {
  const validRoot = await createSourceFixture();
  const valid = spawnSync(process.execPath, [VALIDATE_SCRIPT], {
    cwd: validRoot,
    encoding: 'utf8',
  });
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(valid.stdout, '');

  const invalidRoot = await createSourceFixture();
  await rm(path.join(invalidRoot, 'docs', 'mature-skill-development-plan.md'));
  const invalid = spawnSync(process.execPath, [VALIDATE_SCRIPT], {
    cwd: invalidRoot,
    encoding: 'utf8',
  });
  assert.equal(invalid.status, 1);
  assert.match(
    invalid.stdout,
    /^ERROR SOURCE_FILE_MISSING docs\/mature-skill-development-plan\.md .+\n$/u,
  );
  assert.equal(invalid.stderr, '');
});
