import { timingSafeEqual } from 'node:crypto';
import { request as httpRequest } from 'node:http';

export function equalSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export async function readBody(req, limit = 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw new Error('Request body too large.'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
export function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(value));
}
// One absolute deadline covers headers and the complete body; no global dispatcher or retry.
export function cancellationSource(reason) {
  if (reason?.cancelSource === 'connection_disconnected') return 'connection_disconnected';
  if (reason?.cancelSource === 'transport_timeout' || reason?.name === 'TimeoutError') return 'transport_timeout';
  return 'execution_interrupted';
}
export function createLocalFetch({ request = httpRequest, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  return async function localFetch(descriptor, pathname, body, { signal, timeoutMs = 30000 } = {}) {
    const base = new URL(descriptor.url), url = new URL(pathname, base);
    if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.username || base.password || url.origin !== base.origin || url.username || url.password || typeof descriptor.token !== 'string' || !descriptor.token) throw new Error('Only an authenticated loopback adapter is supported.');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) throw new Error('Invalid transport deadline.');
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      let req, response, timer, settled = false;
      const finish = (error, value) => {
        if (settled) return; settled = true;
        clearTimer(timer); signal?.removeEventListener('abort', abort);
        if (error) { req?.destroy(); response?.destroy(); reject(error); } else resolve(value);
      };
      const fail = source => {
        const error = new Error(`Local transport: ${source}; outcome must be checked before any retry.`);
        error.cancelSource = source; error.code = `GROUP_${source.toUpperCase()}`; finish(error);
      };
      const abort = () => fail(cancellationSource(signal?.reason));
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimer(() => fail('transport_timeout'), timeoutMs);
      try {
        req = request(url, { method: payload === undefined ? 'GET' : 'POST', headers: {
          authorization: `Bearer ${descriptor.token}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' })
        } }, res => {
          response = res;
          if (settled) { res.destroy(); return; }
          const chunks = []; let size = 0;
          res.on('data', chunk => {
            size += chunk.length;
            if (size > 4 * 1024 * 1024) return finish(new Error('Local response too large.'));
            chunks.push(Buffer.from(chunk));
          });
          res.on('aborted', () => fail('connection_disconnected'));
          res.on('error', () => fail('connection_disconnected'));
          res.on('close', () => { if (!res.complete) fail('connection_disconnected'); });
          res.on('end', () => {
            if (settled) return;
            try {
              const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              if (res.statusCode < 200 || res.statusCode >= 300) return finish(new Error(result.error ?? `HTTP ${res.statusCode}`));
              finish(null, result);
            } catch (error) { finish(error); }
          });
        });
        req.on('error', () => fail('connection_disconnected'));
        req.end(payload);
      } catch (error) { finish(error); }
    });
  };
}
export const localFetch = createLocalFetch();
