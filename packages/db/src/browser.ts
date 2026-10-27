// ============================================================
// 砚舟 - 浏览器环境 stub
// ============================================================
// 前端 SPA 不需要真实数据库，使用 localStorage 桥接。
// 导出空 stub 让依赖文件可以正常 import，但运行时一切数据库
// 操作走 databaseService 的 browserLoadAll/browserSave 等分支。
// ============================================================

/* eslint-disable @typescript-eslint/no-explicit-any */

const isBrowserStub = (): boolean => true;

export const schema: any = new Proxy(
  {},
  {
    get: (_target, prop: string) => {
      // 返回一个 getter Proxy：访问 .id/.projectId 等列时返回自身（占位）
      return new Proxy(
        {},
        {
          get: (_t, p: string) => {
            // 模拟 Drizzle 列对象：任意字段访问返回自身即可
            return p;
          },
        },
      );
    },
  },
);

export const getDb = (): null => null;

export const initDatabase = async (): Promise<null> => null;
export const closeDatabase = async (): Promise<void> => undefined;
export const saveToDisk = async (_force = false): Promise<void> => undefined;
export const createDbClient = async (): Promise<null> => null;

// Drizzle 操作符 stub —— 浏览器永远不执行（createEntityService 在 !db 分支早返回）
// 但导出必须存在以满足静态 import。
const noopFn: any = () => undefined;
export const eq = noopFn;
export const and = noopFn;
export const or = noopFn;
export const ne = noopFn;
export const isNull = noopFn;
export const isNotNull = noopFn;
export const inArray = noopFn;
export const notInArray = noopFn;
export const like = noopFn;
export const ilike = noopFn;
export const gte = noopFn;
export const gt = noopFn;
export const lte = noopFn;
export const lt = noopFn;
export const sql = noopFn;

export { isBrowserStub as isBrowser };

export default getDb;
