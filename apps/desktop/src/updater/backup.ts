// ============================================================
// apps/desktop/src/updater/backup.ts
// 旧版本自动备份。
//
// 契约来源：ADR D14.3-3（**冻结，强制验收项**）——
//   「替换 `app-runtime/app-server` 或 `web-dist` 前，先把旧目录整体复制到
//     `<userData>/backups/<oldVersion>/`；备份失败 ⇒ **中止更新**，
//     返回 `{ ok: false, error: '备份失败' }`」
// ADR D14.4：备份根 = `<userData>/backups/<oldVersion>/`
// ============================================================

import { promises as fsp } from 'node:fs';
import * as path from 'node:path';

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupError';
  }
}

/**
 * 递归复制目录（**解引用 junction 的语义由调用方决定**）。
 *
 * `fs.cp(recursive: true)` 在 Windows 上对 junction 会跟随复制（dereference 默认 false，
 * 但对目录链接 Node 仍会遍历）。为避免把 `<userData>/data` 整个数据目录复制进备份
 * （体积巨大且无意义），调用方通过 `excludeNames` 显式排除 `data` 条目。
 */
export async function copyDirRecursive(
  src: string,
  dest: string,
  opts: { excludeNames?: string[] } = {},
): Promise<void> {
  const exclude = new Set(opts.excludeNames ?? []);
  await fsp.mkdir(dest, { recursive: true });
  const dirents = await fsp.readdir(src, { withFileTypes: true });
  for (const dirent of dirents) {
    if (exclude.has(dirent.name)) continue;
    const s = path.join(src, dirent.name);
    const d = path.join(dest, dirent.name);

    // 用 stat 而非 lstat 判定（ADR D7.4 F20：junction 的 lstat().isDirectory() 为 false）
    let st;
    try {
      st = await fsp.stat(s);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      await copyDirRecursive(s, d, opts);
    } else if (st.isFile()) {
      await fsp.copyFile(s, d);
    }
    // 其他类型（socket/fifo）忽略
  }
}

export interface BackupResult {
  /** 备份落点 `<userData>/backups/<oldVersion>/<label>/` */
  backupPath: string;
  /** 备份出的字节数（粗略统计，仅用于日志） */
  bytes: number;
}

async function dirSizeOf(dir: string): Promise<number> {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    let dirents;
    try {
      dirents = await fsp.readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of dirents) {
      const p = path.join(cur, dirent.name);
      let st;
      try {
        st = await fsp.stat(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) stack.push(p);
      else if (st.isFile()) total += st.size;
    }
  }
  return total;
}

/**
 * 备份单个目录到 `<backupsDir>/<oldVersion>/<label>/`。
 *
 * @param backupsDir `<userData>/backups`
 * @param oldVersion 当前生效版本（ADR D14.4：备份根 = `<userData>/backups/<oldVersion>/`）
 * @param label 备份标签，如 `app-server` / `web-dist`
 * @param srcDir 被备份的源目录
 * @param excludeNames 不参与备份的条目名（`app-server` 必须传 `['data']`，见 D7.3）
 * @returns 备份落点；**失败一律抛 `BackupError`**（调用方转 `{ ok:false, error:'备份失败' }`）
 */
export async function backupDir(
  backupsDir: string,
  oldVersion: string,
  label: string,
  srcDir: string,
  excludeNames: string[] = [],
): Promise<BackupResult> {
  const safeVersion = String(oldVersion || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_');
  const backupPath = path.join(backupsDir, safeVersion, label);

  // 源目录不存在 ⇒ 视为无需备份（首启未播种场景），返回空备份而不失败
  try {
    const st = await fsp.stat(srcDir);
    if (!st.isDirectory()) throw new BackupError(`备份源不是目录: ${srcDir}`);
  } catch (err) {
    if (err instanceof BackupError) throw err;
    return { backupPath, bytes: 0 };
  }

  try {
    // 备份前清掉同名旧备份，保证可复现（幂等）
    await fsp.rm(backupPath, { recursive: true, force: true });
    await copyDirRecursive(srcDir, backupPath, { excludeNames });
  } catch (err) {
    // 复制中途失败会留下半棵树：清掉再抛，免得下次备份叠加，也免得
    // 回滚逻辑误把半份备份当成可用备份。
    try {
      await fsp.rm(backupPath, { recursive: true, force: true });
    } catch {
      /* 清不掉只能留给下次同名清理 */
    }
    throw new BackupError(`备份失败: ${srcDir} → ${backupPath}：${(err as Error).message}`);
  }

  const bytes = await dirSizeOf(backupPath).catch(() => 0);
  return { backupPath, bytes };
}