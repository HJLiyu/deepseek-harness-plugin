import { spawn } from 'node:child_process';
import readline from 'node:readline';

// Codex app-server resolves its profile directory through the process home
// directory. Some plugin hosts launch us with HOME unset (or set to an empty
// string) while USERPROFILE is valid on Windows, which makes app-server exit
// before initialize with "Could not find home directory". Normalize both names
// for every RPC child; explicit caller values still win.
export function normalizeChildEnv(env) {
  const childEnv = { ...env };
  for (const key of Object.keys(childEnv)) if (childEnv[key] === undefined) delete childEnv[key];
  if (!childEnv.HOME && childEnv.USERPROFILE) childEnv.HOME = childEnv.USERPROFILE;
  if (!childEnv.USERPROFILE && childEnv.HOME) childEnv.USERPROFILE = childEnv.HOME;
  return childEnv;
}

export class RpcProcess {
  constructor(binary, args, { cwd, env, onNotification, onRequest, jsonrpc = false } = {}) {
    const childEnv = normalizeChildEnv({ ...process.env, ...env });
    this.child = spawn(binary, args, { cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.seq = 1;
    this.pending = new Map();
    this.onNotification = onNotification;
    this.onRequest = onRequest;
    this.jsonrpc = jsonrpc;
    this.stderr = '';
    this.failure = null;
    this.closed = false;
    this.child.stderr.on('data', chunk => { this.stderr = (this.stderr + String(chunk)).slice(-8000); });
    this.lines = readline.createInterface({ input: this.child.stdout });
    this.lines.on('line', line => this.#receive(line));
    this.child.on('error', error => this.#fail(new Error(`RPC process failed to start: ${error.message}`)));
    this.child.stdin.on('error', error => this.#fail(new Error(`RPC stdin failed: ${error.message}`)));
    this.child.on('exit', (code, signal) => this.#fail(new Error(`RPC process exited (${code ?? signal}): ${this.stderr.slice(-1600)}`)));
  }

  #fail(error) {
    if (!this.failure) this.failure = error;
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(error); }
    this.pending.clear();
  }

  #send(message) {
    if (this.failure) throw this.failure;
    if (!this.child.stdin.writable) throw new Error(`RPC process stdin is closed: ${this.stderr.slice(-800)}`);
    if (this.jsonrpc) message.jsonrpc = '2.0';
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  #receive(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.method && message.id !== undefined) {
      Promise.resolve().then(() => this.onRequest?.(message.method, message.params, message.id)).then(
        result => this.#send({ id: message.id, result: result ?? {} }),
        error => this.#send({ id: message.id, error: { code: -32000, message: String(error?.message ?? error) } }),
      ).catch(() => { /* the peer is already gone */ });
      return;
    }
    if (message.method) { try { this.onNotification?.(message.method, message.params); } catch { /* observer errors must not kill the RPC loop */ } return; }
    const entry = this.pending.get(message.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(message.id);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  }

  request(method, params = {}, timeoutMs = 60000) {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.seq++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out after ${timeoutMs}ms`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.#send({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  notify(method, params = {}) {
    if (this.failure) return;
    try { this.#send({ method, params }); } catch { /* best effort */ }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.#fail(new Error('RPC process closed.'));
    try { this.lines.close(); } catch { /* ignore */ }
    try { this.child.stdin.end(); } catch { /* ignore */ }
    if (this.child.exitCode === null) {
      await new Promise(resolve=>{
        const timer=setTimeout(resolve,1500);
        this.child.once('exit',()=>{clearTimeout(timer);resolve();});
        try { this.child.kill(); } catch {clearTimeout(timer);resolve();}
      });
    }
  }
}
