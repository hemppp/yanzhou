// ============================================================
// 砚舟 - drizzle-kit 配置
// ============================================================

import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: './data/novelmuse.db',
  },
});