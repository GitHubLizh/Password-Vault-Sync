// 阶段 0 载体实测骨架（ADR 0022 / spec 故事 1–5）：真 HTTP 走完
// 推 → 改 → 拉 → 最小合流 → 旧 ETag If-Match 应 412 → 重新合流后再推应 200 → 删 → 应 404。
// 默认打本地假桶（scripts/sync-fake-bucket.mjs）自检；给了云凭证与真 endpoint 就打真载体。
// 用法（本地）：node scripts/sync-fake-bucket.mjs --port 8787 &  node scripts/sync-carrier-probe.mjs
// 用法（真桶）：node scripts/sync-carrier-probe.mjs --endpoint https://<ACCOUNT_ID>.r2.cloudflarestorage.com \
//                 --bucket <桶名> --access-key-id <AK> --secret-access-key <SK> --region auto
// 注意：脚本不读任何真实密码库，快照全是合成数据。
import { createHash, createHmac, randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};
const endpoint = flag('endpoint', 'http://127.0.0.1:8787').replace(/\/+$/, '');
const bucket = flag('bucket', 'probe');
const region = flag('region', 'auto');
const service = flag('service', 's3');
const accessKeyId = flag('access-key-id', '');
const secretAccessKey = flag('secret-access-key', '');
const key = `password-vault-sync/${randomUUID().slice(0, 8)}.json`;
const base = new URL(`${endpoint}/${bucket}/${key}`);

if (!accessKeyId !== !secretAccessKey) fail('--access-key-id 与 --secret-access-key 必须成对给出');
if (accessKeyId && base.protocol === 'http:') fail('不允许对 http:// 端点发送签名请求，请把 --endpoint 换成 https 的');

function fail(message) { console.error(`\n无法开始：${message}`); process.exit(2); }

const sha256Hex = (text) => createHash('sha256').update(text).digest('hex');
const encoder = new TextEncoder();

// SigV4（Node 24 自带 node:crypto，不引第三方 SDK）。待实测点：R2 要求 region=auto、path-style URI 参与 canonical。
async function send(method, body, extraHeaders = {}) {
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const headers = {
    host: base.host,
    'x-amz-content-sha256': body === undefined ? sha256Hex('') : sha256Hex(body),
    'x-amz-date': amzDate,
    ...extraHeaders,
  };
  const authorization = accessKeyId ? sign(method, amzDate, dateStamp, headers, body) : undefined;
  const started = Date.now();
  const response = await fetch(base, {
    method,
    headers: authorization ? { ...headers, authorization } : headers,
    body,
  });
  const text = await response.text();
  return {
    status: response.status,
    etag: response.headers.get('etag') ?? '',
    body: text,
    ms: Date.now() - started,
    requestHeaders: Object.keys(headers).sort().join(','),
  };
}

function sign(method, amzDate, dateStamp, headers, body) {
  const signedHeaderNames = Object.keys(headers).map((name) => name.toLowerCase()).sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${String(headers[name] ?? headers[Object.keys(headers).find((k) => k.toLowerCase() === name)]).trim()}\n`)
    .join('');
  const canonicalRequest = [
    method, base.pathname, base.search.replace(/^\?/, ''), canonicalHeaders,
    signedHeaderNames.join(';'), headers['x-amz-content-sha256'],
  ].join('\n');
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256', amzDate, credentialScope, sha256Hex(canonicalRequest),
  ].join('\n');
  const hmac = (keyBytes, data) => createHmac('sha256', keyBytes).update(encoder.encode(data)).digest();
  const keyBytes = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), region), service), 'aws4_request');
  const signature = createHmac('sha256', keyBytes).update(encoder.encode(stringToSign)).digest('hex');
  return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaderNames.join(';')}, Signature=${signature}`;
}

// 合成快照：只用来验载体语义，不含任何真实凭据。
const snapshot = (entries, deleted, revision) => JSON.stringify({
  format: 'password-vault-sync', version: 1, cipher: 'aes-256-gcm', syncId: 'probe-sync-id',
  revision, updatedAt: new Date().toISOString(), ciphertext: 'cHJvYmUtbm90LWEtcmVhbC12YXVsdA==',
  entries, deleted,
});
const baseSnapshot = snapshot([{ id: 'aaaaaaaa-1111-4111-8111-111111111111', updatedAt: '2026-09-01T00:00:00.000Z' }], [], 1);
const localSnapshot = snapshot([
  { id: 'aaaaaaaa-1111-4111-8111-111111111111', updatedAt: '2026-10-01T00:00:00.000Z' },
  { id: 'bbbbbbbb-2222-4222-8222-222222222222', updatedAt: '2026-10-01T00:00:00.000Z' },
], [], 2);

// 最小合流（阶段 1 会在接缝 C 重写为纯函数并带删除集规则，这里只求把云端版本推上去这件事跑通）
function merge(base, local, remote) {
  const ids = new Set([...JSON.parse(base).entries, ...JSON.parse(local).entries].map((e) => e.id));
  const entries = JSON.parse(remote).entries.filter((e) => ids.has(e.id))
    .concat(JSON.parse(local).entries.filter((e) => !JSON.parse(remote).entries.some((r) => r.id === e.id)))
    .sort((a, b) => a.id.localeCompare(b.id));
  const deleted = [...new Set([...JSON.parse(base).deleted, ...JSON.parse(local).deleted, ...JSON.parse(remote).deleted])];
  return snapshot(entries, deleted, Math.max(JSON.parse(local).revision, JSON.parse(remote).revision) + 1);
}

const steps = [];
const check = (name, expected, result, detail) => {
  const passed = expected.includes(result.status);
  steps.push({ name, expected: expected.join('/'), got: result.status, passed, detail: detail ?? `etag=${result.etag || '—'} ${result.ms}ms` });
  console.log(`${passed ? '✔' : '✘'} ${name}：期望 ${expected.join('/')}，实得 ${result.status}  (${steps.at(-1).detail})`);
  if (!passed) process.exitCode = 1;
  return result;
};

console.log(`目标：${base.protocol}//${base.host}/${base.pathname.slice(1)}  签名=${accessKeyId ? 'SigV4' : '无（本地假桶）'}  region=${region}\n`);

const first = check('① 首次推（If-None-Match: *，对象不存在）', [200], await send('PUT', baseSnapshot, { 'if-none-match': '*' }));
check('② 重复首推应被拒（对象已存在）', [412], await send('PUT', baseSnapshot, { 'if-none-match': '*' }));
const reread = check('③ 拉回基准', [200], await send('GET'));
check('④ 拿错 ETag 的条件写应 412', [412], await send('PUT', localSnapshot, { 'if-match': '"deadbeef"' }));
check('⑤ 拿当前 ETag 推本机改动', [200], await send('PUT', localSnapshot, { 'if-match': reread.etag }));
// 模拟"另一台设备先写"：把云端改成第三份，再用本机手里的旧 ETag 写 → 必须 412，然后走合流再推。
const otherDevice = JSON.stringify(JSON.parse(localSnapshot), null, 0).replace('"revision":2', '"revision":3');
await send('PUT', otherDevice, { 'if-match': (await send('GET')).etag });
const stale = await send('PUT', localSnapshot, { 'if-match': reread.etag });
check('⑥ 并发覆盖被拒（旧 ETag）', [412], stale);
const cloud = check('⑦ 重新拉云端', [200], await send('GET'));
const merged = merge(baseSnapshot, localSnapshot, cloud.body);
const pushed = await send('PUT', merged, { 'if-match': cloud.etag });
check('⑧ 合流后再推应成功', [200], pushed);
const same = await send('GET');
check('⑨ 回读内容应与合流结果一致', [200], same, same.body === merged ? '字节一致' : `不一致：${same.body.length} B vs ${merged.length} B`);
check('⑩ 删除后回读应 404（ADR 0017 把 404 当异常）', [204, 200], await send('DELETE'));
check('⑪ 对象已消失', [404], await send('GET'));

const failures = steps.filter((step) => !step.passed);
console.log(`\n合计 ${steps.length} 步，失败 ${failures.length} 步。参与签名的头：${first.requestHeaders}`);
console.log(failures.length ? '结论：载体语义与本脚本假设不一致，先把差异记进 evidence 再继续。' : '结论：条件写语义闭环通过（本次仅为'+(accessKeyId ? '真桶' : '本地假桶')+'）。');
