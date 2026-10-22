#!/usr/bin/env node
// LaPage Digital skill update check.
//
// Compares the local skill version (package.json) with the version published on
// the skill's GitHub repository default branch. Dependency-free, never prints
// credentials, and always exits 0 on network problems so it cannot block the
// workflow that called it.
//
// The same file is shipped in every public LaPage skill repository.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_BRANCH = 'main';
const DEFAULT_TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const HELP = `Usage: node scripts/check-update.mjs [options]

Check whether a newer version of this LaPage skill is published on GitHub.

Options:
  --json             Print machine-readable JSON (default: one-line summary)
  --force            Ignore the 24h cache and check now
  --branch <name>    Remote branch to compare against (default: ${DEFAULT_BRANCH})
  --timeout <ms>     Network timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS})
  -h, --help         Show this help

Environment:
  LAPAGE_SKILL_UPDATE_CHECK=0   Disable the check entirely
  LAPAGE_SKILL_CACHE_DIR        Cache directory (default: ~/.cache/lapage-skills)
`;

export function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(value ?? '').trim());
  if (!match) return null;
  return { parts: match.slice(1, 4).map(Number), pre: match[4] ?? '' };
}

// Returns 1 when a > b, -1 when a < b, 0 when equal, null when either is invalid.
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i += 1) {
    if (left.parts[i] !== right.parts[i]) return left.parts[i] > right.parts[i] ? 1 : -1;
  }
  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  return left.pre > right.pre ? 1 : -1;
}

export function parseGitHubRepo(url) {
  const match = /github\.com[/:]([^/\s]+)\/([^/\s#]+?)(?:\.git)?(?:[/#].*)?$/.exec(String(url ?? ''));
  return match ? { owner: match[1], repo: match[2] } : null;
}

function parseArgs(argv) {
  const options = { json: false, force: false, branch: DEFAULT_BRANCH, timeout: DEFAULT_TIMEOUT_MS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--branch') options.branch = argv[++i];
    else if (arg === '--timeout') options.timeout = Number(argv[++i]);
    else if (arg === '-h' || arg === '--help') options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!options.branch) throw new Error('--branch requires a value');
  if (!Number.isFinite(options.timeout) || options.timeout <= 0) throw new Error('--timeout must be a positive number');
  return options;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  } catch {
    // Cache is a convenience; ignore read-only or sandboxed home directories.
  }
}

function isGitCheckout(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === fs.realpathSync(dir);
  } catch {
    return false;
  }
}

async function fetchRemoteVersion({ owner, repo }, branch, timeout) {
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/package.json`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeout),
    headers: { 'user-agent': 'lapage-skill-update-check' },
  });
  if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);
  const data = await response.json();
  if (!parseVersion(data.version)) throw new Error('Remote package.json has no valid version');
  return data.version;
}

export async function checkUpdate({ skillDir, branch = DEFAULT_BRANCH, timeout = DEFAULT_TIMEOUT_MS, force = false } = {}) {
  const pkg = readJson(path.join(skillDir, 'package.json'));
  const repository = typeof pkg?.repository === 'string' ? pkg.repository : pkg?.repository?.url;
  const github = parseGitHubRepo(repository);
  const result = {
    skill: pkg?.lapage?.skill ?? pkg?.name ?? path.basename(skillDir),
    current: pkg?.version ?? null,
    latest: null,
    updateAvailable: false,
    status: 'unknown',
    repository: github ? `https://github.com/${github.owner}/${github.repo}` : null,
    skillDir,
  };

  if (process.env.LAPAGE_SKILL_UPDATE_CHECK === '0') return { ...result, status: 'disabled' };
  if (!github || !parseVersion(result.current)) return { ...result, status: 'error', error: 'package.json is missing a valid version or GitHub repository URL' };

  const cacheDir = process.env.LAPAGE_SKILL_CACHE_DIR || path.join(os.homedir(), '.cache', 'lapage-skills');
  const cacheFile = path.join(cacheDir, `${github.owner}-${github.repo}-${branch}.json`);
  const cached = force ? null : readJson(cacheFile);
  let latest = cached && Date.now() - cached.checkedAt < CACHE_TTL_MS ? cached.latest : null;
  result.cached = Boolean(latest);

  if (!latest) {
    try {
      latest = await fetchRemoteVersion(github, branch, timeout);
      writeJson(cacheFile, { latest, checkedAt: Date.now() });
    } catch (error) {
      return { ...result, status: 'unavailable', error: error.name === 'TimeoutError' ? 'Timed out reaching GitHub' : error.message };
    }
  }

  const order = compareVersions(latest, result.current);
  result.latest = latest;
  result.updateAvailable = order === 1;
  result.status = order === 1 ? 'update-available' : order === -1 ? 'ahead' : 'up-to-date';
  if (result.updateAvailable) {
    result.updateCommand = isGitCheckout(skillDir)
      ? `git -C "${skillDir}" pull --ff-only`
      : `Reinstall the skill from ${result.repository}`;
  }
  return result;
}

function summarize(result) {
  switch (result.status) {
    case 'update-available':
      return `[lapage] ${result.skill} ${result.latest} is available (installed ${result.current}). Update: ${result.updateCommand}`;
    case 'up-to-date':
      return `[lapage] ${result.skill} ${result.current} is up to date.`;
    case 'ahead':
      return `[lapage] ${result.skill} ${result.current} is newer than the published ${result.latest}.`;
    case 'disabled':
      return `[lapage] Update check disabled by LAPAGE_SKILL_UPDATE_CHECK=0.`;
    default:
      return `[lapage] Could not check for ${result.skill} updates (${result.error}); continuing with ${result.current ?? 'the installed version'}.`;
  }
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`);
    process.exit(2);
  }
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  const skillDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const result = await checkUpdate({ skillDir, ...options });
  process.stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : `${summarize(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  await main();
}
