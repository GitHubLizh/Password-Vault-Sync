// worker/index.mjs 的最小类型面：Workers 运行时模块不参与服务端编译，仅供测试导入用。
export interface R2LikeObject {
  httpEtag?: string;
}

export interface R2LikeObjectBody extends R2LikeObject {
  body: ArrayBuffer | Uint8Array;
}

export interface R2LikeBucket {
  get(key: string): Promise<R2LikeObjectBody | null>;
  put(key: string, value: ArrayBuffer | Uint8Array, options?: { onlyIf?: { etagMatches?: string } }): Promise<R2LikeObject | null>;
}

export interface WorkerEnv {
  VAULT_SYNC?: R2LikeBucket;
  VAULT_WRITE_ENDPOINT?: string;
  VAULT_WRITE_BUCKET?: string;
  VAULT_WRITE_REGION?: string;
  VAULT_WRITE_AK?: string;
  VAULT_WRITE_SK?: string;
}

declare const handler: { fetch(request: Request, env?: WorkerEnv): Promise<Response> };

export default handler;
