// Native credentials remain owned by the native runtime. Never return raw status.
export function parseNativeObservation(provider, input, runtimeVersion = null) {
    if (!['claude', 'codex'].includes(provider))
        throw new Error('native_provider_invalid');
    const observation = { provider, authState: 'unknown', authMethod: 'unknown', accountLabel: null, runtimeVersion: typeof runtimeVersion === 'string' && /^[\w.+-]{1,64}$/.test(runtimeVersion) ? runtimeVersion : null };
    if (!input || typeof input !== 'object' || Array.isArray(input))
        return observation;
    if (provider === 'claude') {
        if (typeof input.loggedIn === 'boolean')
            observation.authState = input.loggedIn ? 'signed_in' : 'signed_out';
        if (input.authMethod === 'claude.ai')
            observation.authMethod = 'native_subscription';
        else if (input.authMethod === 'api_key')
            observation.authMethod = 'api_key';
        else if (typeof input.apiProvider === 'string' && input.apiProvider !== 'firstParty')
            observation.authMethod = 'third_party';
    }
    else {
        if (input.account === null && input.requiresOpenaiAuth === true)
            observation.authState = 'signed_out';
        const account = input.account;
        if (account && typeof account === 'object' && !Array.isArray(account) && ['chatgpt', 'apiKey'].includes(account.type)) {
            observation.authState = 'signed_in';
            observation.authMethod = account.type === 'chatgpt' ? 'native_subscription' : 'api_key';
            if (account.type === 'chatgpt' && typeof account.email === 'string' && Array.from(account.email).length <= 160 && !/[\x00-\x1f\x7f]/.test(account.email))
                observation.accountLabel = account.email;
        }
    }
    return observation;
}
import { execFile, spawn } from 'node:child_process';
export class NativeRuntimeError extends Error {
    constructor(code) { super(code); this.code = code; }
}
function fixedExec(command, args, timeout = 10000) { return new Promise((resolve, reject) => execFile(command, args, { encoding: 'utf8', timeout, maxBuffer: 32768 }, (error, stdout) => { if (error)
    return reject(new NativeRuntimeError('native_unavailable')); resolve(stdout); })); }
export async function codexRpc(method, params) {
    if (!['account/read', 'thread/start'].includes(method))
        throw new NativeRuntimeError('native_method_invalid');
    const child = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
    let buffer = '', bytes = 0, finished = false;
    const pending = new Map();
    let nextId = 1;
    const cleanup = () => { finished = true; clearTimeout(timer); child.kill(); };
    const fail = () => { for (const item of pending.values())
        item.reject(new NativeRuntimeError('native_unavailable')); pending.clear(); cleanup(); };
    const timer = setTimeout(fail, 10000);
    child.on('error', fail);
    child.on('exit', () => { if (!finished)
        fail(); });
    child.stdout.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 65536)
            return fail();
        buffer += chunk.toString('utf8');
        for (let newline; (newline = buffer.indexOf('\n')) >= 0;) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            let value;
            try {
                value = JSON.parse(line);
            }
            catch {
                return fail();
            }
            if (value.method && value.id !== undefined) { // Never silently approve native server requests.
                child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: value.id, error: { code: -32000, message: 'local_approval_required' } }) + '\n');
                return fail();
            }
            const item = pending.get(value.id);
            if (item) {
                pending.delete(value.id);
                if (value.error)
                    item.reject(new NativeRuntimeError('native_rejected'));
                else
                    item.resolve(value.result);
            }
        }
    });
    const request = (name, input) => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: name, params: input }) + '\n'); });
    try {
        await request('initialize', { clientInfo: { name: 'codebrief', version: '1.0.0' }, capabilities: { experimentalApi: false } });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }) + '\n');
        return await request(method, params);
    }
    finally {
        cleanup();
    }
}
export async function observeNative(provider, timeout = 10000) { try {
    if (provider === 'claude') {
        const raw = await fixedExec('claude', ['auth', 'status', '--json'], timeout);
        return parseNativeObservation(provider, JSON.parse(raw));
    }
    return parseNativeObservation(provider, await codexRpc('account/read', { refreshToken: false }));
}
catch {
    return parseNativeObservation(provider, null);
} }
export async function createOwnedThread() { const result = await codexRpc('thread/start', {}), id = result?.thread?.id; if (typeof id !== 'string' || !id || id.length > 255 || /[\x00-\x1f]/.test(id))
    throw new NativeRuntimeError('native_receipt_invalid'); return id; }
