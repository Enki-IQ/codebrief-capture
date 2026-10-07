import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedPath } from './tandem-scope.js';
test('directory grants respect boundaries', () => {
    const scope = [{ kind: 'directory', path: 'src/auth' }];
    assert.equal(isAllowedPath('src/auth/index.ts', scope), true);
    assert.equal(isAllowedPath('src/authz/index.ts', scope), false);
    assert.equal(isAllowedPath('../secrets', scope), false);
});
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectScope } from './tandem-scope.js';
function fixture(t) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'tandem-scope-')));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
    git('init', '-q');
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/a'), 'a');
    writeFileSync(join(root, 'outside'), 'outside');
    git('add', '.');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base');
    return { root, git, base: git('rev-parse', 'HEAD') };
}
test('dirty allowed checkpoints are not review-ready; untracked and deletions counted', async (t) => {
    const { root, base } = fixture(t);
    writeFileSync(join(root, 'src/new'), 'new');
    rmSync(join(root, 'outside'));
    const result = await inspectScope(root, base, [{ kind: 'directory', path: 'src' }]);
    assert.equal(result.clean, false);
    assert.deepEqual(result.violations, ['outside scope: outside']);
});
test('committed renames check both sides', async (t) => {
    const { root, git, base } = fixture(t);
    git('mv', 'outside', 'src/moved');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qam', 'rename');
    const result = await inspectScope(root, base, [{ kind: 'directory', path: 'src' }]);
    assert.ok(result.violations.includes('outside scope: outside'));
});
test('new paths through symlink ancestors fail closed and SHA is verified', async (t) => {
    const { root, base } = fixture(t);
    symlinkSync(realpathSync(tmpdir()), join(root, 'src/link'));
    const result = await inspectScope(root, base, [{ kind: 'file', path: 'src/link/new' }]);
    assert.ok(result.violations.includes('unsafe path: src/link/new'));
    await assert.rejects(inspectScope(root, '0'.repeat(40), [{ kind: 'directory', path: 'src' }]));
});
test('scope case variants fail conservatively and clean allowed commits are ready', async (t) => {
    const { root, base } = fixture(t);
    assert.equal((await inspectScope(root, base, [{ kind: 'directory', path: 'src' }])).clean, true);
    assert.equal((await inspectScope(root, base, [{ kind: 'file', path: 'SRC/a' }])).clean, false);
});
test('staged rename uses destination and source status fields', async (t) => {
    const { root, git, base } = fixture(t);
    git('mv', 'outside', 'src/moved');
    const result = await inspectScope(root, base, [{ kind: 'directory', path: 'src' }]);
    assert.equal(result.clean, false);
    assert.ok(result.violations.includes('outside scope: outside'));
});
test('committed allowed changes bind actual base and head revisions', async (t) => {
    const { root, git, base } = fixture(t);
    writeFileSync(join(root, 'src/a'), 'changed');
    git('add', '.');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'allowed');
    const result = await inspectScope(root, base, [{ kind: 'directory', path: 'src' }]);
    assert.equal(result.clean, true);
    assert.equal(result.baseSha, base);
    assert.equal(result.headSha, git('rev-parse', 'HEAD'));
    assert.notEqual(result.headSha, base);
});
