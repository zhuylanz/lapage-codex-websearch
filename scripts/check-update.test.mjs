import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { checkUpdate, compareVersions, parseGitHubRepo } from './check-update.mjs';

test('compareVersions orders semantic versions', () => {
  assert.equal(compareVersions('1.2.0', '1.1.9'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('v0.9.0', '1.0.0'), -1);
  assert.equal(compareVersions('1.0.0', '1.0.0-beta.1'), 1);
  assert.equal(compareVersions('nope', '1.0.0'), null);
});

test('parseGitHubRepo accepts common repository URL shapes', () => {
  const expected = { owner: 'zhuylanz', repo: 'lapage-playwright-cli-skill' };
  assert.deepEqual(parseGitHubRepo('git+https://github.com/zhuylanz/lapage-playwright-cli-skill.git'), expected);
  assert.deepEqual(parseGitHubRepo('git@github.com:zhuylanz/lapage-playwright-cli-skill.git'), expected);
  assert.deepEqual(parseGitHubRepo('https://github.com/zhuylanz/lapage-playwright-cli-skill#readme'), expected);
  assert.equal(parseGitHubRepo('https://example.com/repo'), null);
});

function fixture(version) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lapage-skill-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'fixture-skill',
    version,
    repository: { type: 'git', url: 'git+https://github.com/zhuylanz/fixture-skill.git' },
  }));
  return dir;
}

test('checkUpdate reports a newer remote version from cache', async () => {
  const skillDir = fixture('1.0.0');
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lapage-cache-'));
  fs.writeFileSync(path.join(cacheDir, 'zhuylanz-fixture-skill-main.json'), JSON.stringify({ latest: '1.1.0', checkedAt: Date.now() }));
  process.env.LAPAGE_SKILL_CACHE_DIR = cacheDir;
  try {
    const result = await checkUpdate({ skillDir });
    assert.equal(result.status, 'update-available');
    assert.equal(result.latest, '1.1.0');
    assert.equal(result.cached, true);
    assert.match(result.updateCommand, /fixture-skill/);
  } finally {
    delete process.env.LAPAGE_SKILL_CACHE_DIR;
  }
});

test('checkUpdate can be disabled', async () => {
  process.env.LAPAGE_SKILL_UPDATE_CHECK = '0';
  try {
    const result = await checkUpdate({ skillDir: fixture('1.0.0') });
    assert.equal(result.status, 'disabled');
  } finally {
    delete process.env.LAPAGE_SKILL_UPDATE_CHECK;
  }
});
