import { createHash } from 'node:crypto';
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { assertScaffoldState } from './state.js';
import { escapeMarkdown } from './templates.js';

const SOURCE_MARKER = '<!-- skill-development-scaffold:source -->';
const SCAFFOLD_VERSION = '0.1.0';
const SOURCE_NAME = 'skill-development-scaffold';
const SOURCE_DESCRIPTION = 'Executable Node.js scaffold for developing mature Agent Skills.';
const SOURCE_SCRIPTS = Object.freeze({
  'init:skill': 'node scripts/init-skill.js',
  'recover:lock': 'node scripts/recover-lock.js',
  test: 'node --test',
  validate: 'node scripts/validate.js',
  audit: 'node scripts/audit.js',
  check: 'npm test && npm run validate',
  'gate:delivery': 'node scripts/delivery-gate.js',
});
const SOURCE_FILES = Object.freeze([
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
]);
const INITIALIZED_FILES = Object.freeze(['SKILL.md']);
const OPTIONAL_SOURCE_FILES = new Set();
const REQUIRED_SOURCE_FILES = Object.freeze([
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
]);
const INITIALIZED_CORE_FILES = Object.freeze([
  'README.md',
  'SKILL.md',
  'docs/decisions.md',
  'docs/delivery-report.md',
  'docs/skill-brief.md',
  'evals/evals.json',
  'package-lock.json',
  'package.json',
]);
const TRACK_KEYS = Object.freeze([
  'references',
  'scripts',
  'assets',
  'implicit-trigger',
  'multi-agent',
  'installer',
  'open-source-release',
]);
const DEPENDENCY_KEYS = Object.freeze([
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
]);
const CONTRACTS = Object.freeze({
  brief: {
    path: 'docs/skill-brief.md',
    marker: '<!-- scaffold-contract:skill-brief:v1 -->',
    code: 'BRIEF_CONTRACT_INVALID',
  },
  decisions: {
    path: 'docs/decisions.md',
    marker: '<!-- scaffold-contract:decisions:v1 -->',
    code: 'DECISIONS_CONTRACT_INVALID',
  },
  delivery: {
    path: 'docs/delivery-report.md',
    marker: '<!-- scaffold-contract:delivery-report:v1 -->',
    code: 'DELIVERY_CONTRACT_INVALID',
  },
});
const TOKEN_PATTERN = /\{\{[^{}\r\n]+\}\}/u;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

function addIssue(target, code, issuePath, message) {
  target.push({ code, path: issuePath, message });
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  if (!isPlainObject(value)) {
    return false;
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function hasTrimmedString(value, allowEmpty = false) {
  return typeof value === 'string'
    && value === value.trim()
    && !/[\r\n]/u.test(value)
    && (allowEmpty || value.length > 0);
}

function uniqueIds(values, pattern) {
  const ids = new Set();
  for (const value of values) {
    if (!isPlainObject(value) || typeof value.id !== 'string'
      || !pattern.test(value.id) || ids.has(value.id)) {
      return false;
    }
    ids.add(value.id);
  }
  return true;
}

function claimUniqueValue(values, value) {
  if (values.has(value)) {
    return false;
  }
  values.add(value);
  return true;
}

function isSafeRelativePath(value) {
  return typeof value === 'string'
    && value.length > 0
    && !value.includes('\\')
    && !value.includes('\0')
    && !path.posix.isAbsolute(value)
    && !path.win32.isAbsolute(value)
    && path.win32.parse(value).root === ''
    && path.posix.normalize(value) === value
    && value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === ''
    || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function skipJsonWhitespace(source, cursor) {
  while (cursor.index < source.length && /\s/u.test(source[cursor.index])) {
    cursor.index += 1;
  }
}

function parseJsonStringToken(source, cursor) {
  const start = cursor.index;
  cursor.index += 1;
  while (cursor.index < source.length) {
    if (source[cursor.index] === '\\') {
      cursor.index += 2;
      continue;
    }
    if (source[cursor.index] === '"') {
      cursor.index += 1;
      return JSON.parse(source.slice(start, cursor.index));
    }
    cursor.index += 1;
  }
  throw new SyntaxError('unterminated JSON string');
}

// JSON.parse 会保留最后一个同名键；状态和证据契约必须先消除这种歧义。
function assertUniqueJsonKeys(source) {
  const cursor = { index: 0 };

  function parseValue() {
    skipJsonWhitespace(source, cursor);
    const token = source[cursor.index];
    if (token === '{') {
      parseObject();
      return;
    }
    if (token === '[') {
      parseArray();
      return;
    }
    if (token === '"') {
      parseJsonStringToken(source, cursor);
      return;
    }
    const start = cursor.index;
    while (cursor.index < source.length && !/[\s,\]}]/u.test(source[cursor.index])) {
      cursor.index += 1;
    }
    JSON.parse(source.slice(start, cursor.index));
  }

  function parseObject() {
    cursor.index += 1;
    const keys = new Set();
    skipJsonWhitespace(source, cursor);
    if (source[cursor.index] === '}') {
      cursor.index += 1;
      return;
    }
    while (cursor.index < source.length) {
      skipJsonWhitespace(source, cursor);
      if (source[cursor.index] !== '"') {
        throw new SyntaxError('JSON object key must be a string');
      }
      const key = parseJsonStringToken(source, cursor);
      if (keys.has(key)) {
        throw new SyntaxError(`duplicate JSON key: ${key}`);
      }
      keys.add(key);
      skipJsonWhitespace(source, cursor);
      if (source[cursor.index] !== ':') {
        throw new SyntaxError('JSON object key must be followed by a colon');
      }
      cursor.index += 1;
      parseValue();
      skipJsonWhitespace(source, cursor);
      if (source[cursor.index] === '}') {
        cursor.index += 1;
        return;
      }
      if (source[cursor.index] !== ',') {
        throw new SyntaxError('JSON object entries must be separated by a comma');
      }
      cursor.index += 1;
    }
    throw new SyntaxError('unterminated JSON object');
  }

  function parseArray() {
    cursor.index += 1;
    skipJsonWhitespace(source, cursor);
    if (source[cursor.index] === ']') {
      cursor.index += 1;
      return;
    }
    while (cursor.index < source.length) {
      parseValue();
      skipJsonWhitespace(source, cursor);
      if (source[cursor.index] === ']') {
        cursor.index += 1;
        return;
      }
      if (source[cursor.index] !== ',') {
        throw new SyntaxError('JSON array entries must be separated by a comma');
      }
      cursor.index += 1;
    }
    throw new SyntaxError('unterminated JSON array');
  }

  parseValue();
  skipJsonWhitespace(source, cursor);
  if (cursor.index !== source.length) {
    throw new SyntaxError('unexpected data after JSON value');
  }
}

function parseJson(source) {
  assertUniqueJsonKeys(source);
  return JSON.parse(source);
}

function validatePublishFiles(pkg, mode, errors) {
  if (!Array.isArray(pkg?.files)) {
    addIssue(errors, 'PUBLISH_FILES_INVALID', 'package.json', 'package files must be an array');
    return;
  }

  const logicalPaths = new Set();
  for (const entry of pkg.files) {
    const portable = typeof entry === 'string' ? entry.toLowerCase() : '';
    if (!isSafeRelativePath(entry) || logicalPaths.has(portable)) {
      addIssue(
        errors,
        'PUBLISH_PATH_UNSAFE',
        'package.json#files',
        `unsafe or duplicate publish path: ${String(entry)}`,
      );
    }
    logicalPaths.add(portable);
  }

  const expected = mode === 'source' ? SOURCE_FILES : INITIALIZED_FILES;
  if (!sameJson(pkg.files, expected)) {
    addIssue(
      errors,
      'PUBLISH_FILES_INVALID',
      'package.json',
      `package files must match the ${mode} publish whitelist`,
    );
  }
}

function validateLock(pkg, lock, errors) {
  if (!isPlainObject(lock) || !isPlainObject(lock.packages) || !isPlainObject(lock.packages[''])) {
    addIssue(errors, 'PACKAGE_LOCK_MISMATCH', 'package-lock.json', 'lockfile root metadata is missing');
    return;
  }

  const lockRoot = lock.packages[''];
  const matching = lock.lockfileVersion === 3
    && lock.requires === true
    && lock.name === pkg.name
    && lock.version === pkg.version
    && lockRoot.name === pkg.name
    && lockRoot.version === pkg.version
    && lockRoot.license === pkg.license
    && sameJson(lockRoot.engines, pkg.engines)
    && DEPENDENCY_KEYS.every((key) => sameJson(lockRoot[key], pkg[key]));
  if (!matching) {
    addIssue(
      errors,
      'PACKAGE_LOCK_MISMATCH',
      'package-lock.json',
      'package-lock root metadata does not match package.json',
    );
  }
}

function parseFrontmatter(source) {
  if (!source.startsWith('---\n')) {
    throw new Error('frontmatter must start on the first line');
  }
  const closing = source.indexOf('\n---\n', 4);
  if (closing === -1) {
    throw new Error('frontmatter closing delimiter is missing');
  }

  const values = {};
  for (const line of source.slice(4, closing).split('\n')) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.+)$/u.exec(line);
    if (match === null || Object.hasOwn(values, match[1])) {
      throw new Error('frontmatter contains an invalid or duplicate field');
    }
    const value = JSON.parse(match[2]);
    if (!hasTrimmedString(value)) {
      throw new Error('frontmatter values must be JSON-quoted one-line strings');
    }
    values[match[1]] = value;
  }
  if (!hasExactKeys(values, ['name', 'description'])) {
    throw new Error('frontmatter must contain exactly name and description');
  }
  return values;
}

function parseContractDocument(source, marker) {
  const first = source.indexOf(marker);
  if (first === -1 || first !== source.lastIndexOf(marker)) {
    throw new Error('contract marker must appear exactly once');
  }
  const prefix = `${marker}\n\`\`\`json\n`;
  if (!source.startsWith(prefix, first)) {
    throw new Error('contract marker must be followed immediately by a JSON fence');
  }
  const jsonStart = first + prefix.length;
  const jsonEnd = source.indexOf('\n\`\`\`', jsonStart);
  if (jsonEnd === -1) {
    throw new Error('contract JSON fence is not closed');
  }
  return parseJson(source.slice(jsonStart, jsonEnd));
}

function validateBrief(value) {
  if (!hasExactKeys(value, [
    'schema_version',
    'status',
    'conflicts',
    'acceptance_criteria',
    'tracks',
    'prompt_budget',
  ]) || value.schema_version !== 1
    || !['draft', 'ready'].includes(value.status)
    || !Array.isArray(value.conflicts)
    || !Array.isArray(value.acceptance_criteria)
    || !hasExactKeys(value.tracks, TRACK_KEYS)
    || !hasExactKeys(value.prompt_budget, ['limit_tokens', 'measured_tokens', 'evidence'])) {
    return false;
  }

  const conflictsValid = uniqueIds(value.conflicts, /^CONFLICT-[0-9]+$/u)
    && value.conflicts.every((conflict) => hasExactKeys(
      conflict,
      ['id', 'summary', 'status', 'resolution'],
    )
      && hasTrimmedString(conflict.summary)
      && ['open', 'resolved'].includes(conflict.status)
      && hasTrimmedString(conflict.resolution, true)
      && (conflict.status === 'open'
        ? conflict.resolution === ''
        : conflict.resolution.length > 0));
  const acceptanceValid = uniqueIds(value.acceptance_criteria, /^REQ-[0-9]+$/u)
    && value.acceptance_criteria.every((criterion) => hasExactKeys(
      criterion,
      ['id', 'requirement', 'verification', 'status'],
    )
      && hasTrimmedString(criterion.requirement)
      && hasTrimmedString(criterion.verification, true)
      && ['pending', 'pass', 'blocked'].includes(criterion.status));
  const tracksValid = TRACK_KEYS.every((key) => {
    const track = value.tracks[key];
    return hasExactKeys(track, ['status', 'evidence', 'unblock_condition'])
      && ['enabled', 'disabled', 'blocked'].includes(track.status)
      && hasTrimmedString(track.evidence)
      && hasTrimmedString(track.unblock_condition, true)
      && (track.status === 'blocked'
        ? track.unblock_condition.length > 0
        : track.unblock_condition === '');
  });
  const budget = value.prompt_budget;
  const budgetValid = value.status === 'draft'
    ? budget.limit_tokens === null
      && budget.measured_tokens === null
      && budget.evidence === ''
    : Number.isInteger(budget.limit_tokens)
      && budget.limit_tokens > 0
      && Number.isInteger(budget.measured_tokens)
      && budget.measured_tokens >= 0
      && budget.measured_tokens <= budget.limit_tokens
      && hasTrimmedString(budget.evidence);
  return conflictsValid && acceptanceValid && tracksValid && budgetValid;
}

function validateDecisions(value) {
  const shapeValid = hasExactKeys(value, ['schema_version', 'decisions'])
    && value.schema_version === 1
    && Array.isArray(value.decisions)
    && uniqueIds(value.decisions, /^DEC-[0-9]+$/u)
    && value.decisions.every((decision) => hasExactKeys(
      decision,
      ['id', 'status', 'scope', 'decision', 'evidence', 'supersedes'],
    )
      && ['active', 'superseded'].includes(decision.status)
      && hasTrimmedString(decision.scope)
      && hasTrimmedString(decision.decision)
      && hasTrimmedString(decision.evidence)
      && (decision.supersedes === null || /^DEC-[0-9]+$/u.test(decision.supersedes)));
  if (!shapeValid) {
    return false;
  }

  const priorIds = new Set();
  for (const decision of value.decisions) {
    if (decision.supersedes !== null && !priorIds.has(decision.supersedes)) {
      return false;
    }
    priorIds.add(decision.id);
  }
  return true;
}

function validateDelivery(value) {
  if (!hasExactKeys(value, ['schema_version', 'requirements', 'capability_claims'])
    || value.schema_version !== 1
    || !Array.isArray(value.requirements)
    || !Array.isArray(value.capability_claims)) {
    return false;
  }
  const requirementsValid = uniqueIds(value.requirements, /^REQ-[0-9]+$/u)
    && value.requirements.every((requirement) => hasExactKeys(
      requirement,
      ['id', 'implementation', 'verification', 'status'],
    )
      && hasTrimmedString(requirement.implementation)
      && hasTrimmedString(requirement.verification)
      && ['pass', 'blocked'].includes(requirement.status));
  const claimsValid = value.capability_claims.every((claim) => hasExactKeys(
    claim,
    ['name', 'track', 'evidence'],
  )
    && hasTrimmedString(claim.name)
    && TRACK_KEYS.includes(claim.track)
    && hasTrimmedString(claim.evidence));
  return requirementsValid && claimsValid;
}

function validateEvals(value, skillName) {
  if (!hasExactKeys(value, ['schema_version', 'skill', 'evals'])
    || value.schema_version !== 1
    || value.skill !== skillName
    || !Array.isArray(value.evals)
    || !uniqueIds(value.evals, /^EVAL-[0-9]+$/u)) {
    return false;
  }
  const prompts = new Set();
  return value.evals.every((evaluation) => hasExactKeys(
    evaluation,
    ['id', 'category', 'prompt', 'assertions', 'result'],
  )
    && ['positive', 'negative', 'boundary'].includes(evaluation.category)
    && hasTrimmedString(evaluation.prompt)
    && [...evaluation.prompt].length >= 20
    && claimUniqueValue(prompts, evaluation.prompt)
    && Array.isArray(evaluation.assertions)
    && evaluation.assertions.length > 0
    && uniqueIds(evaluation.assertions, /^ASSERT-[0-9]+$/u)
    && evaluation.assertions.every((item) => hasExactKeys(item, ['id', 'text'])
      && hasTrimmedString(item.text))
    && hasExactKeys(evaluation.result, ['status', 'evidence'])
    && ['not-run', 'pass', 'fail'].includes(evaluation.result.status)
    && hasTrimmedString(evaluation.result.evidence, true)
    && (evaluation.result.status === 'not-run'
      ? evaluation.result.evidence === ''
      : evaluation.result.evidence.length > 0));
}

function compareIssues(left, right) {
  return left.code.localeCompare(right.code, 'en')
    || left.path.localeCompare(right.path, 'en')
    || left.message.localeCompare(right.message, 'en');
}

export async function validateRepository(root) {
  const errors = [];
  const warnings = [];
  const cache = new Map();
  const textCache = new Map();
  const absoluteRoot = path.resolve(root);
  let canonicalRoot;

  try {
    const rootStats = await lstat(absoluteRoot, { bigint: true });
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
      throw new Error('repository root must be a regular directory');
    }
    canonicalRoot = await realpath(absoluteRoot);
  } catch (error) {
    addIssue(errors, 'ROOT_INVALID', '.', error.message);
    return { mode: 'source', errors, warnings };
  }

  async function readBytes(relativePath, options = {}) {
    if (cache.has(relativePath)) {
      return cache.get(relativePath);
    }
    const missingCode = options.missingCode ?? 'FILE_MISSING';
    const optional = options.optional ?? false;
    const parts = relativePath.split('/');
    let current = absoluteRoot;

    try {
      for (let index = 0; index < parts.length; index += 1) {
        current = path.join(current, parts[index]);
        const entry = await lstat(current, { bigint: true });
        const final = index === parts.length - 1;
        if (entry.isSymbolicLink() || (final ? !entry.isFile() : !entry.isDirectory())) {
          throw Object.assign(new Error('path contains a link or unexpected file type'), {
            validationCode: 'PATH_UNSAFE',
          });
        }
      }

      const handle = await open(current, 'r');
      let bytes;
      try {
        const openedStats = await handle.stat({ bigint: true });
        const resolvedTarget = await realpath(current);
        const resolvedStats = await stat(resolvedTarget, { bigint: true });
        if (!isInside(canonicalRoot, resolvedTarget) || !sameIdentity(openedStats, resolvedStats)) {
          throw Object.assign(new Error('file resolved outside the repository or changed identity'), {
            validationCode: 'PATH_UNSAFE',
          });
        }
        bytes = await handle.readFile();

        // 读取前后都复核句柄身份，避免把链接切换竞态误当作仓库内文件。
        const finalStats = await stat(current, { bigint: true });
        if (!sameIdentity(openedStats, finalStats)) {
          throw Object.assign(new Error('file changed while it was being read'), {
            validationCode: 'PATH_UNSAFE',
          });
        }
      } finally {
        await handle.close();
      }
      cache.set(relativePath, bytes);
      return bytes;
    } catch (error) {
      if (error.code === 'ENOENT') {
        if (!optional) {
          addIssue(errors, missingCode, relativePath, 'required file is missing');
        }
      } else {
        addIssue(
          errors,
          error.validationCode ?? 'FILE_READ_FAILED',
          relativePath,
          error.message,
        );
      }
      cache.set(relativePath, null);
      return null;
    }
  }

  async function readText(relativePath, options = {}) {
    if (textCache.has(relativePath)) {
      return textCache.get(relativePath);
    }
    const bytes = await readBytes(relativePath, options);
    if (bytes === null) {
      textCache.set(relativePath, null);
      return null;
    }
    let content = bytes;
    if (content.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
      addIssue(errors, 'TEXT_BOM', relativePath, 'UTF-8 BOM is not allowed');
      content = content.subarray(3);
    }
    let text;
    try {
      text = UTF8_DECODER.decode(content);
    } catch {
      addIssue(errors, 'TEXT_INVALID_UTF8', relativePath, 'file is not valid UTF-8');
      textCache.set(relativePath, null);
      return null;
    }
    if (text.includes('\0')) {
      addIssue(errors, 'TEXT_NUL', relativePath, 'NUL bytes are not allowed');
    }
    if (text.includes('\r')) {
      addIssue(errors, 'TEXT_CRLF', relativePath, 'text files must use LF line endings');
    }
    textCache.set(relativePath, text);
    return text;
  }

  async function scanSourcePublicationEntry(relativePath, required) {
    const absolutePath = path.join(absoluteRoot, ...relativePath.split('/'));
    let entryStats;
    try {
      entryStats = await lstat(absolutePath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        if (required && !cache.has(relativePath)) {
          addIssue(errors, 'SOURCE_FILE_MISSING', relativePath, 'required source path is missing');
        }
        return;
      }
      addIssue(errors, 'FILE_READ_FAILED', relativePath, error.message);
      return;
    }

    if (entryStats.isSymbolicLink()) {
      addIssue(errors, 'PATH_UNSAFE', relativePath, 'source publication path must not be linked');
      return;
    }
    if (entryStats.isFile()) {
      await readText(relativePath, { missingCode: 'SOURCE_FILE_MISSING' });
      return;
    }
    if (!entryStats.isDirectory()) {
      addIssue(errors, 'PATH_UNSAFE', relativePath, 'source publication path has an unsupported type');
      return;
    }

    let entries;
    try {
      entries = await readdir(absolutePath, { withFileTypes: true });
    } catch (error) {
      addIssue(errors, 'FILE_READ_FAILED', relativePath, error.message);
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const child = `${relativePath}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        addIssue(errors, 'PATH_UNSAFE', child, 'source publication path must not be linked');
      } else if (entry.isDirectory()) {
        await scanSourcePublicationEntry(child, true);
      } else if (entry.isFile()) {
        await readText(child, { missingCode: 'SOURCE_FILE_MISSING' });
      } else {
        addIssue(errors, 'PATH_UNSAFE', child, 'source publication path has an unsupported type');
      }
    }
  }

  async function readJson(relativePath, invalidCode, missingCode) {
    const text = await readText(relativePath, { missingCode });
    if (text === null) {
      return null;
    }
    try {
      const value = parseJson(text);
      if (!isPlainObject(value)) {
        throw new Error('top-level JSON value must be an object');
      }
      return value;
    } catch (error) {
      addIssue(errors, invalidCode, relativePath, error.message);
      return null;
    }
  }

  const pkg = await readJson('package.json', 'PACKAGE_JSON_INVALID', 'PACKAGE_JSON_MISSING');
  let mode = pkg?.scaffold?.mode === 'initialized' ? 'initialized' : 'source';
  if (pkg !== null && !['source', 'initialized'].includes(pkg?.scaffold?.mode)) {
    addIssue(errors, 'SCAFFOLD_MODE_INVALID', 'package.json', 'scaffold mode must be source or initialized');
  }
  if (pkg !== null) {
    validatePublishFiles(pkg, mode, errors);
  }

  const lock = await readJson(
    'package-lock.json',
    'PACKAGE_LOCK_INVALID',
    'PACKAGE_LOCK_MISSING',
  );
  if (pkg !== null && lock !== null) {
    validateLock(pkg, lock, errors);
  }

  if (mode === 'source') {
    if (pkg !== null) {
      const sourceMetadataValid = pkg.name === SOURCE_NAME
        && pkg.version === SCAFFOLD_VERSION
        && pkg.description === SOURCE_DESCRIPTION
        && pkg.private === true
        && pkg.type === 'module'
        && pkg.license === 'Apache-2.0'
        && pkg.scaffold?.version === SCAFFOLD_VERSION
        && pkg.scaffold?.mode === 'source'
        && pkg.engines?.node === '>=22'
        && sameJson(pkg.scripts, SOURCE_SCRIPTS);
      if (!sourceMetadataValid) {
        addIssue(
          errors,
          'SOURCE_PACKAGE_INVALID',
          'package.json',
          'source package metadata does not match the scaffold contract',
        );
      }
    }

    const readme = await readText('README.md', { missingCode: 'SOURCE_FILE_MISSING' });
    if (readme !== null && !readme.startsWith(`${SOURCE_MARKER}\n`)) {
      addIssue(errors, 'SOURCE_MARKER_MISSING', 'README.md', 'source README marker is missing');
    }
    for (const relativePath of REQUIRED_SOURCE_FILES) {
      await readText(relativePath, { missingCode: 'SOURCE_FILE_MISSING' });
    }
    for (const relativePath of SOURCE_FILES) {
      await scanSourcePublicationEntry(relativePath, !OPTIONAL_SOURCE_FILES.has(relativePath));
    }

    const stateBytes = await readBytes('.scaffold/state.json', { optional: true });
    if (stateBytes !== null) {
      addIssue(errors, 'SOURCE_STATE_PRESENT', '.scaffold/state.json', 'source mode must not contain state');
    }
    const skillBytes = await readBytes('SKILL.md', { optional: true });
    if (skillBytes !== null) {
      addIssue(errors, 'SOURCE_SKILL_PRESENT', 'SKILL.md', 'source mode must not contain a root Skill');
    }

    const rootLicense = await readText('LICENSE', { missingCode: 'SOURCE_FILE_MISSING' });
    const apacheTemplate = await readText('templates/licenses/Apache-2.0.txt', {
      missingCode: 'SOURCE_FILE_MISSING',
    });
    if (rootLicense !== null && apacheTemplate !== null && rootLicense !== apacheTemplate) {
      addIssue(errors, 'LICENSE_MISMATCH', 'LICENSE', 'source LICENSE must match the Apache template');
    }
  } else {
    const stateSource = await readText('.scaffold/state.json', { missingCode: 'STATE_MISSING' });
    let state = null;
    if (stateSource !== null) {
      try {
        state = parseJson(stateSource);
        assertScaffoldState(state);
      } catch (error) {
        state = null;
        addIssue(errors, 'STATE_INVALID', '.scaffold/state.json', error.message);
      }
    }

    if (state !== null && pkg !== null) {
      const packageMatches = pkg.name === state.skill.name
        && pkg.description === state.skill.description
        && pkg.license === state.skill.license
        && pkg.scaffold?.mode === 'initialized'
        && pkg.scaffold?.version === state.scaffold_version;
      if (!packageMatches) {
        addIssue(
          errors,
          'INITIALIZED_PACKAGE_MISMATCH',
          'package.json',
          'package metadata does not match initialized state',
        );
      }
    }

    for (const relativePath of INITIALIZED_CORE_FILES) {
      await readText(relativePath, { missingCode: 'INITIALIZED_FILE_MISSING' });
    }

    const skillSource = await readText('SKILL.md', { missingCode: 'INITIALIZED_FILE_MISSING' });
    if (skillSource !== null) {
      try {
        const frontmatter = parseFrontmatter(skillSource);
        if (state !== null
          && (frontmatter.name !== state.skill.name
            || frontmatter.description !== state.skill.description)) {
          throw new Error('frontmatter does not match initialized state');
        }
      } catch (error) {
        addIssue(errors, 'SKILL_FRONTMATTER_INVALID', 'SKILL.md', error.message);
      }
    }

    const readme = await readText('README.md', { missingCode: 'INITIALIZED_FILE_MISSING' });
    if (readme !== null && state !== null && !readme.startsWith(`# ${escapeMarkdown(state.skill.name)}\n`)) {
      addIssue(errors, 'README_NAME_MISMATCH', 'README.md', 'README heading must match the Skill name');
    }

    for (const [kind, definition] of Object.entries(CONTRACTS)) {
      const source = await readText(definition.path, { missingCode: 'INITIALIZED_FILE_MISSING' });
      if (source === null) {
        continue;
      }
      try {
        const contract = parseContractDocument(source, definition.marker);
        const valid = kind === 'brief'
          ? validateBrief(contract)
          : kind === 'decisions'
            ? validateDecisions(contract)
            : validateDelivery(contract);
        if (!valid) {
          throw new Error('contract does not match Evidence Contract v1');
        }
      } catch (error) {
        addIssue(errors, definition.code, definition.path, error.message);
      }
    }

    const evals = await readJson(
      'evals/evals.json',
      'EVALS_CONTRACT_INVALID',
      'INITIALIZED_FILE_MISSING',
    );
    if (evals !== null
      && !validateEvals(evals, state?.skill.name ?? pkg?.name)) {
      addIssue(
        errors,
        'EVALS_CONTRACT_INVALID',
        'evals/evals.json',
        'evaluation data does not match Evidence Contract v1',
      );
    }

    const tokenTargets = state === null
      ? INITIALIZED_CORE_FILES
      : Object.keys(state.initial_files);
    for (const relativePath of tokenTargets) {
      const source = await readText(relativePath, { missingCode: 'INITIALIZED_FILE_MISSING' });
      if (source !== null && TOKEN_PATTERN.test(source)) {
        addIssue(errors, 'TOKEN_UNRESOLVED', relativePath, 'unresolved scaffold token remains');
      }
    }

    const selectedLicense = state?.skill.license ?? pkg?.license;
    if (selectedLicense === 'UNLICENSED') {
      const licenseBytes = await readBytes('LICENSE', { optional: true });
      if (licenseBytes !== null) {
        addIssue(errors, 'LICENSE_UNEXPECTED', 'LICENSE', 'UNLICENSED projects must not contain LICENSE');
      }
    } else if (selectedLicense === 'Apache-2.0' || selectedLicense === 'MIT') {
      const licenseText = await readText('LICENSE', { missingCode: 'INITIALIZED_FILE_MISSING' });
      const templatePath = selectedLicense === 'MIT'
        ? 'templates/licenses/MIT.txt'
        : 'templates/licenses/Apache-2.0.txt';
      const template = await readText(templatePath, { missingCode: 'SOURCE_FILE_MISSING' });
      if (licenseText !== null && template !== null) {
        const expected = selectedLicense === 'MIT'
          ? template.replace('{{INITIALIZED_DATE}}', state?.initialized_at.slice(0, 4) ?? '')
          : template;
        if (licenseText !== expected) {
          addIssue(errors, 'LICENSE_MISMATCH', 'LICENSE', 'LICENSE does not match the selected template');
        }
      }
    } else if (selectedLicense !== undefined) {
      addIssue(errors, 'LICENSE_INVALID', 'package.json', 'unsupported initialized license');
    }

    if (state !== null) {
      for (const [relativePath, expectedDigest] of Object.entries(state.initial_files)) {
        const bytes = await readBytes(relativePath, { missingCode: 'INITIALIZED_FILE_MISSING' });
        if (bytes === null) {
          continue;
        }
        const digest = createHash('sha256').update(bytes).digest('hex');
        if (digest !== expectedDigest) {
          addIssue(
            warnings,
            'STATE_DIGEST_DRIFT',
            relativePath,
            'file has changed since initialization',
          );
        }
      }
    }
  }

  errors.sort(compareIssues);
  warnings.sort(compareIssues);
  return { mode, errors, warnings };
}
