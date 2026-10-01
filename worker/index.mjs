// 只读代理 Worker 骨架（ADR 0012 / ADR 0020）。
// 阶段 0 只需要 /ping 提供一个"真实部署出来的 workers.dev URL"给可达性探针第 2 轮用；
// /vaults/* 是阶段 2 只读端的形状预览：只读、同源 serve、不缓存凭据、不提供任何写方法。
// 设计约束照抄 ADR：Worker 不持写权限、不存状态、不解密（它只搬运密文）。
// 故意不设 access-control-allow-origin：只读页由同一个 Worker 同源 serve（ADR 0012），
// 通配 ACAO 只会把"任何网页都能替你拉一次密文"的开孔白白送出去。
const HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'",
};

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { ...HEADERS, 'content-type': 'application/json; charset=utf-8', ...headers },
});

export default {
  async fetch(request, env = {}) {
    const url = new URL(request.url);
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      // 只读端没有写路径：写一律由桌面端直发对象存储（ADR 0020）。
      return json(405, { error: 'READ_ONLY', message: '本代理只提供只读访问。' }, { allow: 'GET, HEAD' });
    }
    if (url.pathname === '/ping' || url.pathname === '/') {
      return new Response(`pong ${Date.now()}`, { status: 200, headers: { ...HEADERS, 'content-type': 'text/plain; charset=utf-8' } });
    }
    const match = /^\/vaults\/([A-Za-z0-9_-]{1,64}\.json)$/.exec(url.pathname);
    if (!match) return json(404, { error: 'NOT_FOUND', message: '没有这个路径。' });
    if (!env.VAULT_SYNC) {
      return json(501, { error: 'NO_BUCKET_BINDING', message: '本 Worker 尚未绑定 R2 桶，阶段 0 只用于 /ping 可达性测试。' });
    }
    const object = await env.VAULT_SYNC.get(`password-vault-sync/${match[1]}`);
    if (!object) {
      // ADR 0017：404 是"同步关系不见了"的异常信号，绝不能被上层当成"云端是空库"。
      return json(404, { error: 'NO_CLOUD_COPY', message: '云端副本不存在。这不是空库，请在电脑上确认后重新锚定。' });
    }
    return new Response(object.body, {
      status: 200,
      headers: {
        ...HEADERS, 'content-type': 'application/octet-stream',
        ...(object.httpEtag ? { etag: object.httpEtag } : {}),
      },
    });
  },
};
