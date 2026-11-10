// 本地载具：把 worker/index.mjs 跑成真 HTTP 服务（阶段 0 写转发本地自测，ADR 0025）。
// 两种 env 形态对应 0025 的两条写路线：
//   ① 内存绑定（binding 路线）：node scripts/sync-worker-local.mjs [--port 8790]
//   ② 上游假桶（SigV4 子请求路线）：node scripts/sync-worker-local.mjs --upstream http://127.0.0.1:8787 --bucket probe [--port 8790]
// ② 才能配 sync-carrier-probe.mjs --worker 跑通本地全闭环（直写与代理写打同一个假桶）；
// ① 的翻译语义由 tests/worker-forward.test.ts 用内存绑定钉住，真桶行为归真桶实测。
// 用法（本地全套）：node scripts/sync-fake-bucket.mjs --port 8787 &  node scripts/sync-worker-local.mjs --upstream http://127.0.0.1:8787 --bucket probe --port 8790 &  node scripts/sync-carrier-probe.mjs --worker http://127.0.0.1:8790
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import worker from '../worker/index.mjs';

const flag = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback;
};
const port = Number(flag('port', 8790));
const upstream = flag('upstream', '');

// 内存绑定复刻官方语义（Workers API reference）：get 命中给 body + httpEtag；
// put 的 onlyIf 前置条件失败返回 null；成功返回新对象元数据。ETag 形态照 R2/S3 惯例带引号（真桶实测项）。
function memoryBinding() {
  const objects = new Map();
  const etagOf = (value) => `"${createHash('md5').update(value).digest('hex')}"`;
  return {
    async get(key) {
      const object = objects.get(key);
      return object ? { body: object.body, httpEtag: object.etag } : null;
    },
    async put(key, value, options = {}) {
      const current = objects.get(key);
      const expected = options?.onlyIf?.etagMatches;
      if (expected !== undefined && (!current || current.etag !== expected)) return null;
      const body = Buffer.from(value);
      const etag = etagOf(body);
      objects.set(key, { body, etag });
      return { httpEtag: etag };
    },
  };
}

const env = upstream
  ? {
      VAULT_WRITE_ENDPOINT: upstream,
      VAULT_WRITE_BUCKET: flag('bucket', 'probe'),
      VAULT_WRITE_REGION: flag('region', 'auto'),
      VAULT_WRITE_AK: flag('ak', 'local-test-key'),
      VAULT_WRITE_SK: flag('sk', 'local-test-secret'),
    }
  : { VAULT_SYNC: memoryBinding() };

const server = createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', async () => {
    try {
      const hasBody = request.method !== 'GET' && request.method !== 'HEAD' && chunks.length > 0;
      const target = new Request(`http://127.0.0.1:${port}${request.url}`, {
        method: request.method,
        headers: request.headers,
        ...(hasBody ? { body: Buffer.concat(chunks) } : {}),
      });
      const result = await worker.fetch(target, env);
      const out = Buffer.from(await result.arrayBuffer());
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(out);
    } catch (error) {
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(`本地载具抛错：${String((error && error.message) || error)}`);
    }
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`本地 Worker 已监听 http://127.0.0.1:${port}（${upstream ? `② SigV4 子请求 → ${upstream}` : '① 内存绑定'}）`);
});
