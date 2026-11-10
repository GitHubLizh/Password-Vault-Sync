// 同步代理 Worker（ADR 0012，写转发与备选读转发按修订 ADR 0025）。
// 读：GET/HEAD /vaults/<同步标识>.json 转发桶内密文字节；写：PUT 同路径 + If-Match 条件写转发。
// 两条部署形态（0025 的①②）：① R2 binding——读 get、写 put(onlyIf)，官方 Workers API reference
// 写明"前置条件失败时 put() 返回 null"，凭证即 binding，Worker 内零 AK/SK；② 无 binding 的 SigV4
// 子请求——读与写都打 S3 API（binding 的 onlyIf 真桶实测不通过时的完整备选，AK/SK 走 wrangler secret）。
// 设计约束照抄 ADR：Worker 不存状态、不解密（只搬运密文）；412 在转发层 1:1 保留（0025）——
// 它是 0009 合流安全的唯一并发判据。故意不设 access-control-allow-origin：页面由同一个 Worker
// 同源 serve（0012），通配 ACAO 等于白送"任何网页都能替你读写密文"的开孔。
// 写端点无法鉴权是 0025 记账的已知限制：实际闸门是同步标识不可猜（0010）+ 同步密钥解不开垃圾密文。
const HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'",
};

// 8 MiB 库上限 + 信封余量（spec 故事 53：超限报错，不硬塞）。
const MAX_FORWARD_BYTES = 8 * 1024 * 1024 + 64 * 1024;

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { ...HEADERS, 'content-type': 'application/json; charset=utf-8', ...headers },
});

const VAULT_KEY = /^\/vaults\/([A-Za-z0-9_-]{1,64}\.json)$/;

export default {
  async fetch(request, env = {}) {
    const url = new URL(request.url);
    const method = request.method;

    if (method === 'GET' || method === 'HEAD') {
      if (url.pathname === '/ping' || url.pathname === '/') {
        return new Response(`pong ${Date.now()}`, { status: 200, headers: { ...HEADERS, 'content-type': 'text/plain; charset=utf-8' } });
      }
      const match = VAULT_KEY.exec(url.pathname);
      if (!match) return json(404, { error: 'NOT_FOUND', message: '没有这个路径。' });

      if (env.VAULT_SYNC) {
        const object = await env.VAULT_SYNC.get(`password-vault-sync/${match[1]}`);
        if (!object) {
          // ADR 0017：404 是"同步关系不见了"的异常信号，绝不能被上层当成"云端是空库"。
          return json(404, { error: 'NO_CLOUD_COPY', message: '云端副本不存在。这不是空库，请在电脑上确认后重新锚定。' });
        }
        return new Response(object.body, {
          status: 200,
          headers: { ...HEADERS, 'content-type': 'application/octet-stream', ...(object.httpEtag ? { etag: object.httpEtag } : {}) },
        });
      }
      if (writeCredentials(env)) {
        return forwardSignedGet(env, `password-vault-sync/${match[1]}`);
      }
      return json(501, { error: 'NO_BUCKET_BINDING', message: '本 Worker 尚未绑定 R2 桶也未配置转发凭证，阶段 0 只用于 /ping 可达性测试。' });
    }

    if (method === 'PUT') {
      const match = VAULT_KEY.exec(url.pathname);
      if (!match) return json(404, { error: 'NOT_FOUND', message: '没有这个路径。' });
      const ifMatch = (request.headers.get('if-match') ?? '').trim();
      if (!ifMatch) {
        return json(400, { error: 'IF_MATCH_REQUIRED', message: '写转发必须携带 If-Match；本代理不提供无条件写，首建一律由桌面端直发。' });
      }
      const body = await request.arrayBuffer();
      if (body.byteLength > MAX_FORWARD_BYTES) {
        return json(413, { error: 'TOO_LARGE', message: `快照 ${body.byteLength} B 超过转发上限 ${MAX_FORWARD_BYTES} B。` });
      }
      const key = `password-vault-sync/${match[1]}`;

      if (env.VAULT_SYNC) {
        // ① binding 条件写。前置条件失败 → put() 返回 null（Workers API reference 原文），映射成 412。
        let written = null;
        try {
          written = await env.VAULT_SYNC.put(key, body, { onlyIf: { etagMatches: ifMatch } });
        } catch (error) {
          return json(502, { error: 'BINDING_PUT_FAILED', message: `binding put 抛错：${String((error && error.message) || error)}` });
        }
        if (!written) {
          return json(412, { error: 'PRECONDITION_FAILED', message: 'If-Match 与云端当前版本不符。先拉云端合流，再重试写。' });
        }
        return new Response(null, {
          status: 200,
          headers: { ...HEADERS, ...(written.httpEtag ? { etag: written.httpEtag } : {}) },
        });
      }

      if (writeCredentials(env)) {
        return forwardSignedPut(env, key, body, ifMatch);
      }
      return json(501, { error: 'NO_BUCKET_BINDING', message: '本 Worker 未绑定 R2 桶也未配置转发凭证，无法转发写。' });
    }

    return json(405, { error: 'METHOD_NOT_ALLOWED', message: '本代理只提供读转发与带 If-Match 的写转发。' }, { allow: 'GET, HEAD, PUT' });
  },
};

const writeCredentials = (env) => Boolean(env.VAULT_WRITE_ENDPOINT && env.VAULT_WRITE_AK && env.VAULT_WRITE_SK);

// ② 的 SigV4 子请求：Workers 的 WebCrypto 自签（与 scripts/sync-carrier-probe.mjs 的 Node 版同构）。
// region 固定 auto、path-style 参与规范化——这两点与桌面直发一样，仍是真桶实测项。
const encoder = new TextEncoder();
const hex = (buffer) => [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
const sha256Hex = async (text) => hex(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
const hmac = async (keyBytes, data) => new Uint8Array(await crypto.subtle.sign(
  'HMAC',
  await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
  encoder.encode(data),
));

async function signedSubrequest(env, method, key, { body, ifMatch } = {}) {
  const endpoint = String(env.VAULT_WRITE_ENDPOINT).replace(/\/+$/, '');
  const bucket = String(env.VAULT_WRITE_BUCKET ?? '');
  const region = String(env.VAULT_WRITE_REGION ?? 'auto');
  const target = new URL(`${endpoint}/${bucket}/${key}`);
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = body ? hex(await crypto.subtle.digest('SHA-256', body)) : await sha256Hex('');
  const headers = {
    host: target.host,
    ...(ifMatch ? { 'if-match': ifMatch } : {}),
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  const names = Object.keys(headers).map((name) => name.toLowerCase()).sort();
  const canonicalHeaders = names.map((name) => `${name}:${headers[name]}\n`).join('');
  const canonicalRequest = [method, target.pathname, '', canonicalHeaders, names.join(';'), payloadHash].join('\n');
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest)].join('\n');
  let keyBytes = encoder.encode(`AWS4${env.VAULT_WRITE_SK}`);
  for (const part of [dateStamp, region, 's3', 'aws4_request']) keyBytes = await hmac(keyBytes, part);
  const signature = hex(await hmac(keyBytes, stringToSign));
  const authorization = `AWS4-HMAC-SHA256 Credential=${env.VAULT_WRITE_AK}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
  return fetch(target, { method, headers: { ...headers, authorization }, body });
}

async function forwardSignedGet(env, key) {
  const response = await signedSubrequest(env, 'GET', key);
  if (response.status === 200) {
    const bytes = await response.arrayBuffer();
    const etag = response.headers.get('etag') ?? '';
    return new Response(bytes, {
      status: 200,
      headers: { ...HEADERS, 'content-type': 'application/octet-stream', ...(etag ? { etag } : {}) },
    });
  }
  return json(response.status, {
    error: response.status === 404 ? 'NO_CLOUD_COPY' : 'FORWARD_FAILED',
    message: `上游对象存储对这次读返回 ${response.status}。`,
    upstream: response.status,
  });
}

async function forwardSignedPut(env, key, body, ifMatch) {
  const response = await signedSubrequest(env, 'PUT', key, { body, ifMatch });
  if (response.status === 200) {
    const etag = response.headers.get('etag') ?? '';
    return new Response(null, { status: 200, headers: { ...HEADERS, ...(etag ? { etag } : {}) } });
  }
  // 状态码 1:1 透传（0025：转发不许吞掉 412）。
  return json(response.status, {
    error: response.status === 412 ? 'PRECONDITION_FAILED' : response.status === 404 ? 'NO_CLOUD_COPY' : 'FORWARD_FAILED',
    message: `上游对象存储对这次条件写返回 ${response.status}。`,
    upstream: response.status,
  });
}
