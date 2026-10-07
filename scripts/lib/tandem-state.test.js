import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tandemNamespace } from './tandem-state.js';
test('worktree and tenant isolate local markers', () => {
    const a = { accountId: 'u', orgId: 'o', repoId: 'r', worktreeId: 'w1', attemptId: 'a' };
    assert.notEqual(tandemNamespace(a), tandemNamespace({ ...a, worktreeId: 'w2' }));
    assert.notEqual(tandemNamespace(a), tandemNamespace({ ...a, orgId: 'other' }));
});
import { mkdtempSync, realpathSync, mkdirSync, rmSync, statSync, symlinkSync, linkSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { saveTandemState, loadTandemState, worktreeIdentity, migrateLegacyHandoff } from './tandem-state.js';
import { saveActiveHandoff, loadActiveHandoff, repoHash } from './handoff-state.js';
const identity = { accountId: 'u', orgId: 'o', repoId: 'r', worktreeId: 'w', attemptId: 'a' };
function temporary(t) { const d = realpathSync(mkdtempSync(join(tmpdir(), 'tandem-state-'))); t.after(() => rmSync(d, { recursive: true, force: true })); return d; }
test('private persistent state isolates tenant/worktree/attempt and rejects linked paths', t => {
    const baseDir = join(temporary(t), 'config');
    const opts = { baseDir };
    saveTandemState(identity, { checkpoint: 'dirty' }, opts);
    assert.deepEqual(loadTandemState(identity, opts), { checkpoint: 'dirty' });
    for (const key of ['accountId', 'orgId', 'repoId', 'worktreeId', 'attemptId'])
        assert.equal(loadTandemState({ ...identity, [key]: 'other' }, opts), null);
    const directory = join(baseDir, 'tandem/v2', tandemNamespace(identity));
    const path = join(directory, 'state.json');
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    linkSync(path, join(directory, 'hardlink'));
    assert.throws(() => saveTandemState(identity, {}, opts), /unsafe/);
});
test('symlink state directory fails closed', t => {
    const root = temporary(t);
    mkdirSync(join(root, 'config'));
    symlinkSync(root, join(root, 'config/tandem'));
    assert.throws(() => saveTandemState(identity, {}, { baseDir: join(root, 'config') }), /unsafe/);
});
test('worktree identity persists outside repo and distinguishes linked worktrees', t => {
    const root = temporary(t);
    const repo = join(root, 'repo');
    mkdirSync(repo);
    const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
    git('init');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'base');
    const linked = join(root, 'linked');
    git('worktree', 'add', '-b', 'linked', linked);
    const opts = { baseDir: join(root, 'config') };
    const first = worktreeIdentity(repo, opts);
    assert.equal(worktreeIdentity(repo, opts), first);
    assert.notEqual(worktreeIdentity(linked, opts), first);
});
test('legacy requires authenticated match and consumes once across worktrees', async (t) => {
    const opts = { baseDir: join(temporary(t), 'config') };
    saveActiveHandoff({ repoFullName: 'org/repo', handoffId: '11111111-1111-4111-8111-111111111111', actionId: '22222222-2222-4222-8222-222222222222', actionVersion: 1, host: 'codex', startMarker: '2026-10-04T00:00:00.000Z' }, opts);
    assert.equal((await migrateLegacyHandoff(identity, 'org/repo', async () => false, opts)).status, 'recovery_required');
    assert.ok(loadActiveHandoff('org/repo', opts));
    assert.equal((await migrateLegacyHandoff(identity, 'org/repo', async () => true, opts)).status, 'migrated');
    assert.equal((await migrateLegacyHandoff({ ...identity, worktreeId: 'other' }, 'org/repo', async () => true, opts)).status, 'recovery_required');
});
test('recent lock prevents concurrent state writes and repository cannot hold identity', t => {
    const root = temporary(t), baseDir = join(root, 'config');
    const opts = { baseDir };
    saveTandemState(identity, { original: true }, opts);
    const dir = join(baseDir, 'tandem/v2', tandemNamespace(identity));
    // Empty recent legacy lock is also held; only aged same-owner residue is reclaimed.
    writeFileSync(join(dir, '.write.lock'), '');
    assert.throws(() => saveTandemState(identity, {}, opts), /busy/);
    assert.deepEqual(loadTandemState(identity, opts), { original: true });
    const repo = join(root, 'repo');
    mkdirSync(repo);
    execFileSync('git', ['-C', repo, 'init', '-q']);
    assert.throws(() => worktreeIdentity(repo, { baseDir: join(repo, 'private') }), /outside repository/);
});

function legacyFixture(t) {
    const opts = { baseDir: join(temporary(t), 'config') };
    saveActiveHandoff({ repoFullName: 'org/repo', handoffId: '11111111-1111-4111-8111-111111111111', actionId: '22222222-2222-4222-8222-222222222222', actionVersion: 1, host: 'codex', startMarker: '2026-10-04T00:00:00.000Z' }, opts);
    const destination = join(opts.baseDir, 'tandem/v2', tandemNamespace(identity), 'state.json');
    const migrate = () => migrateLegacyHandoff(identity, 'org/repo', async () => true, opts);
    return { opts, destination, migrate };
}
test('migration replay preserves a newer checkpoint', async t => {
    const { opts, migrate } = legacyFixture(t);
    await migrate();
    saveTandemState(identity, { checkpoint: 'newer', claim: 'active' }, opts);
    assert.equal((await migrate()).status, 'migrated');
    assert.deepEqual(loadTandemState(identity, opts), { checkpoint: 'newer', claim: 'active' });
});
test('first migration preserves an existing valid destination', async t => {
    const { opts, migrate } = legacyFixture(t);
    saveTandemState(identity, { checkpoint: 'existing' }, opts);
    assert.equal((await migrate()).status, 'migrated');
    assert.deepEqual(loadTandemState(identity, opts), { checkpoint: 'existing' });
});
test('migration fails closed for malformed or wrongly bound destination state', async t => {
    const { opts, destination, migrate } = legacyFixture(t);
    saveTandemState(identity, { checkpoint: 'existing' }, opts);
    for (const raw of ['{broken', JSON.stringify({ schemaVersion: 2, namespace: 'wrong', state: {} }), JSON.stringify({ schemaVersion: 2, namespace: tandemNamespace(identity) })]) {
        writeFileSync(destination, raw);
        await assert.rejects(migrate(), /invalid Tandem migration destination/);
        assert.equal(readFileSync(destination, 'utf8'), raw);
    }
    assert.ok(loadActiveHandoff('org/repo', opts));
});
test('recorded consumption repairs a destination that was never installed', async t => {
    const { opts, destination, migrate } = legacyFixture(t);
    // Create only managed directories, then block the destination installation.
    assert.equal(loadTandemState(identity, opts), null);
    const lock = join(destination, '..', '.write.lock');
    writeFileSync(lock, '');
    await assert.rejects(migrate(), /busy/);
    assert.equal(existsSync(destination), false);
    assert.equal(existsSync(join(opts.baseDir, 'tandem/legacy', `${repoHash('org/repo')}.json`)), true);
    rmSync(lock);
    assert.equal((await migrate()).status, 'migrated');
    assert.deepEqual(loadTandemState(identity, opts), { legacyHandoff: loadActiveHandoff('org/repo', opts) });
});
