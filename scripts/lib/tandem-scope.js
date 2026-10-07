import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, realpath, readdir } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
const execute = promisify(execFile);
function validPath(path) {
    return typeof path === 'string' && path.length > 0 && path.length <= 4096 && !path.startsWith('/') && !path.includes('\\') && !/[\x00-\x1f\x7f]/.test(path) && !path.split('/').some(p => !p || p === '.' || p === '..' || p.toLowerCase() === '.git');
}
function validScope(scope) {
    return Array.isArray(scope) && scope.length > 0 && scope.length <= 100 && scope.every(s => s && Object.keys(s).length === 2 && ['file', 'directory'].includes(s.kind) && validPath(s.path));
}
export function isAllowedPath(path, scope) {
    return validPath(path) && validScope(scope) && scope.some(s => path === s.path || (s.kind === 'directory' && path.startsWith(s.path + '/')));
}
async function git(root, args) {
    const { stdout } = await execute('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_COUNT: '0' } });
    return stdout;
}
function diffPaths(raw) {
    const fields = raw.split('\0');
    const paths = [];
    for (let i = 0; i < fields.length && fields[i];) {
        const status = fields[i++];
        const path = fields[i++];
        if (!path || !/^[ACDMRTUXB][0-9]*$/.test(status))
            throw new Error('invalid Git diff');
        paths.push(path);
        if (/^[RC]/.test(status)) {
            if (!fields[i])
                throw new Error('invalid Git rename');
            paths.push(fields[i++]);
        }
    }
    return paths;
}
function statusPaths(raw) {
    const fields = raw.split('\0');
    const paths = [];
    for (let i = 0; i < fields.length && fields[i];) {
        const entry = fields[i++];
        if (entry.length < 4 || entry[2] !== ' ')
            throw new Error('invalid Git status');
        paths.push(entry.slice(3));
        if (/[RC]/.test(entry.slice(0, 2))) {
            if (!fields[i])
                throw new Error('invalid Git rename');
            paths.push(fields[i++]);
        }
    }
    return paths;
}
async function pathSafe(root, path) {
    let current = root;
    for (const component of path.split('/')) {
        let names;
        try {
            names = await readdir(current);
        }
        catch (e) {
            if (e.code === 'ENOENT')
                break;
            if (e.code === 'ENOTDIR')
                return false;
            throw e;
        }
        const matches = names.filter(n => n.normalize('NFC').toLocaleLowerCase('en-US') === component.normalize('NFC').toLocaleLowerCase('en-US'));
        if (matches.some(n => n !== component) || matches.length > 1)
            return false;
        current = join(current, component);
        let stat;
        try {
            stat = await lstat(current);
        }
        catch (e) {
            if (e.code === 'ENOENT')
                break;
            throw e;
        }
        if (stat.isSymbolicLink())
            return false;
        const canonical = await realpath(current);
        if (canonical !== root && !canonical.startsWith(root + sep))
            return false;
    }
    return true;
}
/** Dirty checkpoints are permitted; clean is the review-readiness gate. */
export async function inspectScope(root, baseSha, scope) {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(baseSha) || !validScope(scope))
        throw new TypeError('invalid scope inspection');
    const canonical = await realpath(resolve(root));
    const top = (await git(canonical, ['rev-parse', '--show-toplevel'])).trim();
    if (await realpath(top) !== canonical)
        throw new Error('scope root must be worktree root');
    const verified = (await git(canonical, ['rev-parse', '--verify', `${baseSha}^{commit}`])).trim();
    const headSha = (await git(canonical, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
    if (verified !== baseSha || headSha.length !== baseSha.length)
        throw new Error('invalid commit SHA');
    const [diff, status, census] = await Promise.all([
        git(canonical, ['diff', '--no-ext-diff', '--no-textconv', '--name-status', '-z', baseSha, 'HEAD']),
        git(canonical, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
        git(canonical, ['ls-files', '-z']),
    ]);
    const paths = [...new Set([...diffPaths(diff), ...statusPaths(status)])];
    const violations = [];
    const folded = new Map();
    for (const path of [...census.split('\0').filter(Boolean), ...paths, ...scope.map(s => s.path)]) {
        const key = path.normalize('NFC').toLocaleLowerCase('en-US');
        const prev = folded.get(key);
        if (prev && prev !== path)
            violations.push(`ambiguous case: ${path}`);
        folded.set(key, path);
    }
    for (const path of [...new Set([...paths, ...scope.map(s => s.path)])]) {
        if (!validPath(path) || !await pathSafe(canonical, path))
            violations.push(`unsafe path: ${path}`);
    }
    for (const path of paths)
        if (!isAllowedPath(path, scope))
            violations.push(`outside scope: ${path}`);
    const finalHead = (await git(canonical, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
    const finalStatus = await git(canonical, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    if (finalHead !== headSha || finalStatus !== status)
        violations.push('worktree changed during inspection');
    return { dirty: statusPaths(status), untracked: status.split('\0').filter(v=>v.startsWith('?? ')).map(v=>v.slice(3)), clean: status.length === 0 && violations.length === 0, violations: [...new Set(violations)], baseSha, headSha };
}

/** Review binds actual immutable Git commits without exporting repository content. */
export async function inspectReviewRevision(root, revision) {
    const canonical = await realpath(resolve(root));
    if (await realpath((await git(canonical, ['rev-parse','--show-toplevel'])).trim()) !== canonical) throw new Error('review requires worktree root');
    if (![revision.baseSha,revision.headSha].every(v => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(v))) throw new TypeError('invalid review revision');
    const head = (await git(canonical,['rev-parse','--verify','HEAD^{commit}'])).trim();
    const base = (await git(canonical,['rev-parse','--verify',`${revision.baseSha}^{commit}`])).trim();
    const status = await git(canonical,['status','--porcelain=v1','-z','--untracked-files=all']);
    const finalHead = (await git(canonical,['rev-parse','--verify','HEAD^{commit}'])).trim();
    const finalStatus = await git(canonical,['status','--porcelain=v1','-z','--untracked-files=all']);
    if (base !== revision.baseSha || head !== revision.headSha || finalHead !== head || status || finalStatus !== status) throw new Error('Review requires clean worktree at frozen author revision; claim retained for recovery');
    return {headSha:head,baseSha:base,clean:true};
}

export async function preflightReviewWorktree(root) {
    const canonical = await realpath(resolve(root));
    if(await realpath((await git(canonical,['rev-parse','--show-toplevel'])).trim()) !== canonical || await git(canonical,['status','--porcelain=v1','-z','--untracked-files=all'])) throw new Error('Review claim requires clean Git worktree root');
}
