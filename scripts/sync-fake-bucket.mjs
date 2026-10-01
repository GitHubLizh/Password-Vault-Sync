// 本地假桶：用真 HTTP 复刻对象存储的条件写语义，供 sync-carrier-probe.mjs 在没有云账号时自测。
// 语义依据（2026-10-01 文档核实，尚未在真桶上实测）：If-None-Match: * 已存在→412；
// If-Match 与当前 ETag 不符→412；对象不存在时 If-Match→404；成功写→200 且返回新 ETag。
// 用法：node scripts/sync-fake-bucket.mjs [--port 8787] [--bucket probe]
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};
const port = Number(flag('port', 8787));
const objects = new Map();
const etagOf = (body) => `"${createHash('md5').update(body).digest('hex')}"`;
const normalize = (value) => String(value ?? '').trim();

const server = createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const body = Buffer.concat(chunks);
    const path = request.url.split('?')[0];
    const ifMatch = normalize(request.headers['if-match']);
    const ifNoneMatch = normalize(request.headers['if-none-match']);
    const current = objects.get(path);
    let status = 200;
    let note = '';
    let payloadBody = Buffer.alloc(0);

    if (request.method === 'PUT') {
      if (ifNoneMatch === '*' && current) { status = 412; note = 'if-none-match:* 但对象已存在'; }
      else if (ifMatch && !current) { status = 404; note = 'if-match 但对象不存在'; }
      else if (ifMatch && ifMatch !== current.etag) { status = 412; note = `if-match ${ifMatch} ≠ 当前 ${current.etag}`; }
      else {
        const etag = etagOf(body);
        objects.set(path, { body, etag });
        status = 200; note = `写入 ${body.length} B`;
        response.setHeader('etag', etag);
      }
    } else if (request.method === 'GET' || request.method === 'HEAD') {
      if (!current) { status = 404; note = '对象不存在'; }
      else if (ifNoneMatch && ifNoneMatch === current.etag) { status = 304; note = '未修改'; }
      else { note = `返回 ${current.body.length} B`; response.setHeader('etag', current.etag); response.setHeader('content-type', 'application/octet-stream'); payloadBody = current.body; }
    } else if (request.method === 'DELETE') {
      if (!current) { status = 404; note = '对象不存在'; }
      else { objects.delete(path); status = 204; note = '已删除'; }
    } else {
      status = 405; note = '只支持 PUT/GET/HEAD/DELETE';
    }

    console.log(`${request.method.padEnd(6)} ${path} -> ${status}  ${note}`);
    if (request.method === 'HEAD' || status === 204 || status === 304) { response.writeHead(status); response.end(); return; }
    if (status >= 400) response.setHeader('content-type', 'application/xml');
    const payload = status >= 400
      ? Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${status === 412 ? 'PreconditionFailed' : status === 404 ? 'NoSuchKey' : 'MethodNotAllowed'}</Code><Message>${note}</Message></Error>`)
      : payloadBody;
    response.writeHead(status, { 'content-length': String(Buffer.byteLength(payload)) });
    response.end(payload);
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`假桶已监听 http://127.0.0.1:${port} （内存态，进程退出即清空；已存对象 ${objects.size} 个）`);
});
