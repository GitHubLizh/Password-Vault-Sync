import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import worker, { type R2LikeBucket, type WorkerEnv } from '../worker/index.mjs';

// 复刻官方 binding 语义（Workers API reference：precondition 失败 → put() 返回 null）。
// 真桶上的实际行为（含 etagMatches 的形态与语义）归阶段 0 实测钉死，这里只钉我们的翻译。
function memoryBinding(): R2LikeBucket {
  const objects = new Map<string, { body: Buffer; etag: string }>();
  const etagOf = (value: Uint8Array) => `"${createHash('md5').update(value).digest('hex')}"`;
  return {
    async get(key: string) {
      const object = objects.get(key);
      return object ? { body: object.body, httpEtag: object.etag } : null;
    },
    async put(key: string, value: ArrayBuffer, options: { onlyIf?: { etagMatches?: string } } = {}) {
      const current = objects.get(key);
      const expected = options.onlyIf?.etagMatches;
      if (expected !== undefined && (!current || current.etag !== expected)) return null;
      const body = Buffer.from(value);
      const etag = etagOf(body);
      objects.set(key, { body, etag });
      return { httpEtag: etag };
    },
  };
}

const PATH = '/vaults/0123456789ab.json';
const OBJECT_KEY = 'password-vault-sync/0123456789ab.json';

const call = (method: string, env: WorkerEnv, init: { path?: string; body?: string; headers?: Record<string, string> } = {}) =>
  worker.fetch(new Request(`https://probe.example${init.path ?? PATH}`, {
    method,
    body: init.body,
    headers: init.headers,
  }), env);

test('写转发不带 If-Match 被拒 400', async () => {
  const response = await call('PUT', { VAULT_SYNC: memoryBinding() }, { body: 'x' });
  assert.equal(response.status, 400);
  assert.match(await response.text(), /IF_MATCH_REQUIRED/);
});

test('未绑桶亦无转发凭证时 PUT 拒 501', async () => {
  const response = await call('PUT', {}, { body: 'x', headers: { 'if-match': '"a"' } });
  assert.equal(response.status, 501);
});

test('快照超过 8 MiB 余量被拒 413', async () => {
  const oversized = 'x'.repeat(8 * 1024 * 1024 + 64 * 1024 + 1);
  const response = await call('PUT', { VAULT_SYNC: memoryBinding() }, { body: oversized, headers: { 'if-match': '"a"' } });
  assert.equal(response.status, 413);
  assert.match(await response.text(), /TOO_LARGE/);
});

test('带当前 ETag 的条件写成功并回新 ETag', async () => {
  const bucket = memoryBinding();
  await bucket.put(OBJECT_KEY, Buffer.from('seed'));
  const etag = (await bucket.get(OBJECT_KEY))?.httpEtag;
  assert.ok(etag);
  const response = await call('PUT', { VAULT_SYNC: bucket }, { body: 'next', headers: { 'if-match': etag! } });
  assert.equal(response.status, 200);
  const newEtag = response.headers.get('etag');
  assert.equal(newEtag, `"${createHash('md5').update('next').digest('hex')}"`);
  assert.notEqual(newEtag, etag);
});

test('旧 ETag 的条件写被拒 412', async () => {
  const bucket = memoryBinding();
  await bucket.put(OBJECT_KEY, Buffer.from('seed'));
  const response = await call('PUT', { VAULT_SYNC: bucket }, { body: 'next', headers: { 'if-match': '"deadbeef"' } });
  assert.equal(response.status, 412);
  assert.match(await response.text(), /PRECONDITION_FAILED/);
});

test('对象不存在时条件写按前置条件失败处理为 412', async () => {
  const response = await call('PUT', { VAULT_SYNC: memoryBinding() }, { body: 'next', headers: { 'if-match': '"a"' } });
  assert.equal(response.status, 412);
});

test('binding put 抛错映射 502 并带原因', async () => {
  const bucket: R2LikeBucket = {
    get: async () => null,
    put: async () => { throw new Error('binding 炸了'); },
  };
  const response = await call('PUT', { VAULT_SYNC: bucket }, { body: 'x', headers: { 'if-match': '"a"' } });
  assert.equal(response.status, 502);
  assert.match(await response.text(), /BINDING_PUT_FAILED/);
});

test('经代理拉回透传字节与 ETag', async () => {
  const bucket = memoryBinding();
  await bucket.put(OBJECT_KEY, Buffer.from('seed'));
  const response = await call('GET', { VAULT_SYNC: bucket });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'seed');
  assert.ok(response.headers.get('etag'));
});

test('云端副本不存在按 ADR 0017 当异常报 404', async () => {
  const response = await call('GET', { VAULT_SYNC: memoryBinding() });
  assert.equal(response.status, 404);
  assert.match(await response.text(), /NO_CLOUD_COPY/);
});

test('其他方法一律 405 且 allow 含 PUT', async () => {
  const response = await call('POST', { VAULT_SYNC: memoryBinding() }, { body: 'x' });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET, HEAD, PUT');
});

test('/ping 回 pong', async () => {
  const response = await call('GET', {}, { path: '/ping' });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /pong/);
});

test('未知路径 404', async () => {
  const response = await call('GET', { VAULT_SYNC: memoryBinding() }, { path: '/nope' });
  assert.equal(response.status, 404);
});
