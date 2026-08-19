import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  lstat,
  mkdtemp,
  open,
  readFile,
  readlink,
  realpath,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

const MAX_COMMAND_OUTPUT = 128 * 1024 * 1024;
const CREDENTIAL_PATTERNS = Object.freeze([
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/gu,
  /\bgithub_pat_[A-Za-z0-9_]{70,}\b/gu,
  /\bnpm_[A-Za-z0-9]{36,}\b/gu,
  /\bsk_live_[A-Za-z0-9]{20,}\b/gu,
  /(?<![A-Za-z0-9-])xox[bp]-[A-Za-z0-9-]{20,}(?![A-Za-z0-9-])/gu,
  /(?<![A-Za-z0-9_-])AIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/gu,
  /(?<![A-Za-z0-9_-])glpat-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/gu,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gu,
  /\bauthorization\s*:\s*bearer\s+[A-Za-z0-9._~+/=-]{16,}(?=$|[\s"'`,;)\]}])/gimu,
  /-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----/gu,
  /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|secret)\s*[:=]\s*["']?[A-Za-z0-9+/=_-]{20,}/giu,
  /https?:\/\/[^\s/:@]+:[^\s/@]+@/giu,
]);
const WINDOWS_ABSOLUTE_PATTERN = /\b[A-Za-z]:[\\/][^\s"'`<>|]+/gu;
const UNIX_PRIVATE_PATTERN = /\/(?:Users|home)\/[^/\s"'`<>]+(?:\/[^\s"'`<>]*)?/gu;
const SAFE_WINDOWS_ROOTS = new Set([
  'example',
  'fixture',
  'missing-repository',
  'outside',
  'repo',
  'repository',
  'temp',
  'tmp',
  'unused',
]);
const SAFE_PROFILE_NAMES = new Set(['example', 'tester', 'user', 'username']);
const SENSITIVE_NAMES = Object.freeze([
  /^\.env(?:\..+)?$/iu,
  /^\.netrc$/iu,
  /^\.npmrc$/iu,
  /^\.pypirc$/iu,
  /^credentials?(?:\.[^.]+)?$/iu,
  /^id_(?:dsa|ecdsa|ed25519|rsa)(?:\.pub)?$/iu,
  /^secrets?(?:\.[^.]+)?$/iu,
  /\.(?:key|p12|pfx|pem)$/iu,
]);
const SAFE_SENSITIVE_NAMES = new Set([
  '.env.example',
  '.env.sample',
  '.env.template',
]);
const PACKAGE_TOP_LEVEL = new Set([
  'AGENTS.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'LICENSE',
  'README.md',
  'SECURITY.md',
  'SKILL.md',
  'docs',
  'package.json',
  'scripts',
  'src',
  'templates',
]);
const PACKAGE_FORBIDDEN_ROOTS = new Set([
  '.git',
  '.scaffold',
  'coverage',
  'eval',
  'evals',
  'eval-workspaces',
  'evaluation-workspaces',
  'node_modules',
  'tests',
]);
const WINDOWS_DEVICE_PATTERN = /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu;
// 只识别事务模块生成的 UUID 文件名，避免把用户正常维护的 .stage 或 .backup 文件误判为恢复证据。
const TRANSACTION_ARTIFACT_PATTERN = /^\..+\.[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.(?:\d+\.stage|backup|[a-z][a-z-]*-detached)$/iu;

function compareIssues(left, right) {
  return left.code.localeCompare(right.code, 'en')
    || left.location.localeCompare(right.location, 'en');
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === ''
    || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function normalizeRelativePath(value) {
  if (typeof value !== 'string'
    || value.length === 0
    || value.includes('\0')
    || /^[A-Za-z]:/u.test(value)
    || /^[\\/]{1,2}/u.test(value)) {
    return null;
  }
  const portable = value.replaceAll('\\', '/');
  if (portable.split('/').includes('..')) {
    return null;
  }
  const normalized = path.posix.normalize(portable);
  if (normalized === '.'
    || normalized === '..'
    || normalized.startsWith('../')
    || normalized.split('/').includes('..')) {
    return null;
  }
  return normalized;
}

function safeLocation(scope, relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  // 文件名也可能携带凭据，问题位置必须使用与正文相同的脱敏边界。
  if (normalized === null
    || CREDENTIAL_PATTERNS.some((pattern) => {
      pattern.lastIndex = 0;
      return pattern.test(normalized);
    })) {
    return `${scope}:<redacted>`;
  }
  return `${scope}:${normalized}`;
}

function sensitiveFilename(relativePath) {
  const basename = path.posix.basename(relativePath).toLowerCase();
  if (SAFE_SENSITIVE_NAMES.has(basename)) {
    return false;
  }
  return SENSITIVE_NAMES.some((pattern) => pattern.test(basename));
}

function isSafeProfileName(value) {
  return SAFE_PROFILE_NAMES.has(value.toLowerCase())
    || value.startsWith('<')
    || value.startsWith('$')
    || value.startsWith('%');
}

function isSafeWindowsRoot(value) {
  const normalized = value.toLowerCase();
  return SAFE_WINDOWS_ROOTS.has(normalized)
    || SAFE_WINDOWS_ROOTS.has(normalized.replace(/\.[^.]+$/u, ''));
}

function containsPrivateAbsolutePath(text) {
  WINDOWS_ABSOLUTE_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(WINDOWS_ABSOLUTE_PATTERN)) {
    const segments = match[0].slice(3).split(/[\\/]/u).filter(Boolean);
    if (segments[0]?.toLowerCase() === 'users') {
      if (segments[1] !== undefined && !isSafeProfileName(segments[1])) {
        return true;
      }
    } else if (segments[0] !== undefined && !isSafeWindowsRoot(segments[0])) {
      return true;
    }
  }

  UNIX_PRIVATE_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(UNIX_PRIVATE_PATTERN)) {
    const [, profile = ''] = match[0].split('/').filter(Boolean);
    if (!isSafeProfileName(profile)) {
      return true;
    }
  }
  return false;
}

function containsCredential(text) {
  return CREDENTIAL_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

function publicEmail(email) {
  const normalized = email.trim().toLowerCase();
  if (normalized === 'tester@example.invalid' || normalized === 'noreply@github.com') {
    return true;
  }
  const match = /^(?:\d+\+)?([a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?)(?:\[bot\])?@users\.noreply\.github\.com$/u
    .exec(normalized);
  return match !== null && !match[1].includes('--');
}

function npmInvocation() {
  // 直接调用 npm CLI，避免 Windows 无法可靠地把 npm.cmd 当作普通可执行文件启动。
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean);
  const cli = candidates.find((candidate) => existsSync(candidate));
  if (cli !== undefined) {
    return { command: process.execPath, prefix: [cli] };
  }
  return { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', prefix: [] };
}

function runCommand(root, command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'buffer',
    windowsHide: true,
    maxBuffer: MAX_COMMAND_OUTPUT,
    ...options,
  });
  if (result.error !== undefined || result.status !== 0) {
    const error = new Error(`command failed: ${command}`);
    error.code = result.error?.code ?? 'COMMAND_FAILED';
    throw error;
  }
  return result.stdout;
}

function git(root, args) {
  return runCommand(root, 'git', args);
}

function parseIndexEntries(buffer) {
  return buffer.toString('utf8').split('\0').filter(Boolean).map((line) => {
    const separator = line.indexOf('\t');
    const metadata = line.slice(0, separator).split(' ');
    return {
      mode: metadata[0],
      objectId: metadata[1],
      path: line.slice(separator + 1),
    };
  });
}

function parseTreeEntries(buffer) {
  return buffer.toString('utf8').split('\0').filter(Boolean).map((entry) => {
    const separator = entry.indexOf('\t');
    const [mode, type, objectId] = entry.slice(0, separator).split(' ');
    return { mode, type, objectId, path: entry.slice(separator + 1) };
  });
}

function dangerousLink(root, relativePath, target) {
  if (target.includes('\0')
    || path.isAbsolute(target)
    || /^[A-Za-z]:[\\/]/u.test(target)
    || /^[/\\]{2}/u.test(target)) {
    return true;
  }
  const resolved = path.resolve(root, path.dirname(relativePath), target);
  return !isInside(root, resolved);
}

async function readTrackedFile(root, canonicalRoot, relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  if (normalized === null) {
    throw Object.assign(new Error('unsafe tracked path'), { auditCode: 'TRACKED_PATH_UNSAFE' });
  }
  const parts = normalized.split('/');
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    const stats = await lstat(current);
    if (stats.isSymbolicLink()) {
      const target = await readlink(current);
      throw Object.assign(new Error('tracked path contains a link'), {
        auditCode: dangerousLink(root, parts.slice(0, index + 1).join('/'), target)
          ? 'DANGEROUS_LINK'
          : 'TRACKED_LINK',
      });
    }
    if (index < parts.length - 1 && !stats.isDirectory()) {
      throw Object.assign(new Error('tracked parent is not a directory'), {
        auditCode: 'TRACKED_PATH_UNSAFE',
      });
    }
  }
  const resolved = await realpath(current);
  if (!isInside(canonicalRoot, resolved)) {
    throw Object.assign(new Error('tracked file resolves outside repository'), {
      auditCode: 'TRACKED_PATH_UNSAFE',
    });
  }
  const handle = await open(current, 'r');
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function packagePath(entryPath, entryType) {
  if (typeof entryPath !== 'string' || entryPath.includes('\\')) {
    return null;
  }
  const candidate = entryType === 'directory' && entryPath.endsWith('/')
    ? entryPath.slice(0, -1)
    : entryPath;
  const normalized = normalizeRelativePath(candidate);
  if (normalized === null) {
    return null;
  }
  const segments = candidate.split('/');
  // npm 包会在不同文件系统解包，因此路径必须同时满足 POSIX 与 Windows 的安全边界。
  if (normalized !== candidate
    || segments.some((segment) => segment.length === 0
      || /[<>:"|?*\u0000-\u001f]/u.test(segment)
      || /[. ]$/u.test(segment)
      || WINDOWS_DEVICE_PATTERN.test(segment))) {
    return null;
  }
  const relativePath = normalized.startsWith('package/')
    ? normalized.slice('package/'.length)
    : normalized;
  return relativePath.length === 0 ? null : relativePath;
}

function tarText(buffer, offset, length) {
  const field = buffer.subarray(offset, offset + length);
  const terminator = field.indexOf(0);
  return field.subarray(0, terminator === -1 ? field.length : terminator).toString('utf8');
}

function tarSize(buffer, offset) {
  const value = tarText(buffer, offset + 124, 12).trim().replace(/\0+$/u, '');
  if (!/^[0-7]+$/u.test(value)) {
    throw new Error('tar entry has an invalid size');
  }
  const size = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_COMMAND_OUTPUT) {
    throw new Error('tar entry is too large');
  }
  return size;
}

function parsePaxAttributes(buffer) {
  const attributes = {};
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space === -1) {
      throw new Error('invalid pax record');
    }
    const length = Number.parseInt(buffer.subarray(offset, space).toString('ascii'), 10);
    if (!Number.isSafeInteger(length) || length <= 0 || offset + length > buffer.length) {
      throw new Error('invalid pax record length');
    }
    const record = buffer.subarray(space + 1, offset + length - 1).toString('utf8');
    const separator = record.indexOf('=');
    if (separator !== -1) {
      attributes[record.slice(0, separator)] = record.slice(separator + 1);
    }
    offset += length;
  }
  return attributes;
}

function parsePackageArchive(buffer) {
  const entries = [];
  let globalAttributes = {};
  let nextAttributes = {};
  let nextLongPath;
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      break;
    }
    const size = tarSize(header, 0);
    const contentStart = offset + 512;
    const contentEnd = contentStart + size;
    if (contentEnd > buffer.length) {
      throw new Error('tar entry exceeds archive bounds');
    }
    const content = buffer.subarray(contentStart, contentEnd);
    const typeFlag = String.fromCharCode(header[156] || 0);
    if (typeFlag === 'g' || typeFlag === 'x') {
      const attributes = parsePaxAttributes(content);
      if (typeFlag === 'g') {
        globalAttributes = { ...globalAttributes, ...attributes };
      } else {
        nextAttributes = attributes;
      }
    } else if (typeFlag === 'L') {
      nextLongPath = tarText(content, 0, content.length);
    } else {
      const prefix = tarText(header, 345, 155);
      const headerPath = [prefix, tarText(header, 0, 100)].filter(Boolean).join('/');
      const attributes = { ...globalAttributes, ...nextAttributes };
      const entryPath = attributes.path ?? nextLongPath ?? headerPath;
      const linkPath = attributes.linkpath ?? tarText(header, 157, 100);
      const type = typeFlag === '\0' || typeFlag === '0' || typeFlag === '7'
        ? 'file'
        : typeFlag === '1'
          ? 'hardlink'
          : typeFlag === '2'
            ? 'symlink'
            : typeFlag === '5'
              ? 'directory'
              : `type-${typeFlag}`;
      entries.push({
        path: entryPath,
        type,
        linkPath,
        content: type === 'file' ? content : undefined,
      });
      nextAttributes = {};
      nextLongPath = undefined;
    }
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function validatePackageEntries(entries, addIssue, scanContent) {
  for (const entry of entries) {
    const relativePath = packagePath(entry?.path, entry?.type);
    if (relativePath === null) {
      addIssue('PACKAGE_PATH_UNSAFE', 'package:<redacted>');
      continue;
    }
    const location = safeLocation('package', relativePath);
    const segments = relativePath.split('/');
    const [topLevel] = segments;
    if (entry?.type === 'symlink' || entry?.type === 'hardlink') {
      addIssue('PACKAGE_LINK', location);
    } else if (entry?.type !== undefined
      && entry.type !== 'file'
      && entry.type !== 'directory') {
      addIssue('PACKAGE_ENTRY_UNSAFE', location);
    }
    const containsForbiddenDirectory = segments
      .slice(0, -1)
      .some((segment) => PACKAGE_FORBIDDEN_ROOTS.has(segment.toLowerCase()));
    const containsTransactionArtifact = segments
      .some((segment) => TRANSACTION_ARTIFACT_PATTERN.test(segment));
    if (sensitiveFilename(relativePath)) {
      addIssue('SENSITIVE_FILENAME', location);
    } else if (!PACKAGE_TOP_LEVEL.has(topLevel)
      || containsForbiddenDirectory
      || containsTransactionArtifact
      || relativePath.toLowerCase().endsWith('.log')) {
      addIssue('PACKAGE_FILE_FORBIDDEN', location);
    }
    if ((entry?.type === undefined || entry.type === 'file') && entry?.content !== undefined) {
      scanContent(entry.content, location);
    }
  }
}

async function loadPackageEntries(root) {
  // 在仓库外生成真实归档，既覆盖未跟踪发布文件，也不污染待审计工作区。
  const destination = await mkdtemp(path.join(tmpdir(), 'skill-scaffold-audit-'));
  try {
    const npm = npmInvocation();
    const output = runCommand(root, npm.command, [
      ...npm.prefix,
      'pack',
      '--json',
      '--ignore-scripts',
      '--pack-destination',
      destination,
    ]);
    const report = JSON.parse(output.toString('utf8'));
    const filename = report?.[0]?.filename;
    if (typeof filename !== 'string'
      || filename.length === 0
      || path.basename(filename) !== filename) {
      throw new Error('npm pack returned an unsafe filename');
    }
    const archivePath = path.join(destination, filename);
    const archiveStats = await lstat(archivePath);
    if (!archiveStats.isFile() || archiveStats.isSymbolicLink()
      || archiveStats.size > MAX_COMMAND_OUTPUT) {
      throw new Error('npm pack returned an unsafe archive');
    }
    const archive = await readFile(archivePath);
    return parsePackageArchive(gunzipSync(archive, { maxOutputLength: MAX_COMMAND_OUTPUT }));
  } finally {
    await rm(destination, { recursive: true, force: true });
  }
}

export async function auditRepository(root, context = {}) {
  const absoluteRoot = path.resolve(root);
  const issues = [];
  const issueKeys = new Set();
  const addIssue = (code, location) => {
    const safeCode = /^[A-Z][A-Z0-9_]+$/u.test(code) ? code : 'AUDIT_FAILED';
    const safeIssueLocation = /^[^\n\0]+$/u.test(location) ? location : '<redacted>';
    const key = `${safeCode}\0${safeIssueLocation}`;
    if (!issueKeys.has(key)) {
      issueKeys.add(key);
      issues.push({ code: safeCode, location: safeIssueLocation });
    }
  };
  const scanContent = (content, location) => {
    const text = Buffer.isBuffer(content) ? content.toString('utf8') : String(content);
    if (containsCredential(text)) {
      addIssue('CREDENTIAL_DETECTED', location);
    }
    if (containsPrivateAbsolutePath(text)) {
      addIssue('PRIVATE_PATH_DETECTED', location);
    }
  };

  let canonicalRoot;
  try {
    const rootStats = await lstat(absoluteRoot);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
      throw new Error('invalid repository root');
    }
    canonicalRoot = await realpath(absoluteRoot);
  } catch {
    return { issues: [{ code: 'ROOT_INVALID', location: '.' }] };
  }

  let trackedEntries = [];
  try {
    trackedEntries = parseIndexEntries(git(absoluteRoot, ['ls-files', '-z', '--stage']));
  } catch {
    addIssue('GIT_SCAN_FAILED', 'git:index');
  }
  for (const entry of trackedEntries) {
    const location = safeLocation('worktree', entry.path);
    if (normalizeRelativePath(entry.path) === null) {
      addIssue('TRACKED_PATH_UNSAFE', location);
      continue;
    }
    if (sensitiveFilename(entry.path)) {
      addIssue('SENSITIVE_FILENAME', location);
    }
    if (entry.mode === '120000') {
      try {
        const target = git(absoluteRoot, ['cat-file', 'blob', entry.objectId]).toString('utf8');
        if (dangerousLink(absoluteRoot, entry.path, target)) {
          addIssue('DANGEROUS_LINK', location);
        }
      } catch {
        addIssue('GIT_SCAN_FAILED', 'git:index-link');
      }
      continue;
    }
    try {
      scanContent(await readTrackedFile(absoluteRoot, canonicalRoot, entry.path), location);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        addIssue(error?.auditCode ?? 'WORKTREE_READ_FAILED', location);
      }
    }
  }

  try {
    const commits = git(absoluteRoot, ['rev-list', '--all'])
      .toString('utf8').split(/\r?\n/u).filter(Boolean);
    // 同一 blob 可被多个提交引用，只扫描一次即可保持结果稳定并限制历史审计成本。
    const scannedBlobs = new Set();
    for (const commit of commits) {
      const metadata = git(absoluteRoot, [
        'show', '-s', '--format=%H%x00%ae%x00%ce%x00%B', commit,
      ]).toString('utf8').split('\0');
      const [commitId = commit, authorEmail = '', committerEmail = '', message = ''] = metadata;
      if (!publicEmail(authorEmail)) {
        addIssue('PRIVATE_EMAIL', `commit:${commitId.slice(0, 12)}:author`);
      }
      if (!publicEmail(committerEmail)) {
        addIssue('PRIVATE_EMAIL', `commit:${commitId.slice(0, 12)}:committer`);
      }
      scanContent(message, `commit:${commitId.slice(0, 12)}:message`);

      const treeEntries = parseTreeEntries(git(absoluteRoot, ['ls-tree', '-rz', '--full-tree', commit]));
      for (const entry of treeEntries) {
        const historyLocation = safeLocation(
          `history:${commitId.slice(0, 12)}`,
          entry.path,
        );
        if (sensitiveFilename(entry.path)) {
          addIssue('SENSITIVE_FILENAME', historyLocation);
        }
        if (entry.mode === '120000') {
          const target = git(absoluteRoot, ['cat-file', 'blob', entry.objectId]).toString('utf8');
          if (dangerousLink(absoluteRoot, entry.path, target)) {
            addIssue('DANGEROUS_LINK', historyLocation);
          }
        }
        if (entry.type === 'blob' && !scannedBlobs.has(entry.objectId)) {
          scannedBlobs.add(entry.objectId);
          scanContent(
            git(absoluteRoot, ['cat-file', 'blob', entry.objectId]),
            `history:${entry.objectId.slice(0, 12)}`,
          );
        }
      }
    }

    const tags = git(absoluteRoot, [
      'for-each-ref', 'refs/tags', '--format=%(objecttype)%00%(objectname)',
    ]).toString('utf8').split(/\r?\n/u).filter(Boolean);
    for (const tag of tags) {
      const [type = '', objectId = ''] = tag.split('\0');
      if (type !== 'tag' || !/^[0-9a-f]{40,64}$/u.test(objectId)) {
        continue;
      }
      const rawTag = git(absoluteRoot, ['cat-file', 'tag', objectId]).toString('utf8');
      const tagger = /^tagger .*<([^<>\n]+)> \d+ [+-]\d{4}$/mu.exec(rawTag);
      if (tagger === null || !publicEmail(tagger[1])) {
        addIssue('PRIVATE_EMAIL', `tag:${objectId.slice(0, 12)}:tagger`);
      }
      const messageStart = rawTag.indexOf('\n\n');
      scanContent(
        messageStart === -1 ? '' : rawTag.slice(messageStart + 2),
        `tag:${objectId.slice(0, 12)}:message`,
      );
    }

    const refs = git(absoluteRoot, ['for-each-ref', '--format=%(refname)'])
      .toString('utf8').split(/\r?\n/u).filter(Boolean);
    for (const ref of refs) {
      const digest = createHash('sha256').update(ref).digest('hex').slice(0, 12);
      scanContent(ref, `ref:${digest}`);
    }
  } catch {
    addIssue('GIT_SCAN_FAILED', 'git:history');
  }

  try {
    validatePackageEntries(
      context.packEntries === undefined
        ? await loadPackageEntries(absoluteRoot)
        : context.packEntries,
      addIssue,
      scanContent,
    );
  } catch {
    addIssue('PACKAGE_AUDIT_FAILED', 'package:.');
  }

  issues.sort(compareIssues);
  return { issues };
}
