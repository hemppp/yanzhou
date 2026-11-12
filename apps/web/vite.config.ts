import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { createHtmlPlugin } from 'vite-plugin-html';

export default defineConfig(({ command, mode }) => {
  // ★ 仓库根 = apps/web 的上两级。dev(serve) 时把 envDir 指向它，使 web 与 server
  //   共用**同一份**根 .env（与 apps/server/src/env.ts 的 pnpm-workspace.yaml 锚点一致）；
  //   此前 web 的 envDir 默认是 apps/web，根 .env 里的 VITE_* 实际读不到 ⇒ 死配置。
  //   ⚠ build 保持 Vite 默认（apps/web）**不**读根 .env：否则本地打包会把根 .env 的
  //   绝对地址（http://localhost:3774/api）烧进生产/桌面产物，而生产要求相对 /api
  //   （内嵌 server 同源托管 web-dist）。需绝对地址的部署请在 CI/进程环境设
  //   VITE_API_BASE_URL —— 下面的 process.env 分支仍优先，不受影响。
  //   注意：dev 读入后 VITE_API_BASE_URL 是绝对地址，浏览器将**跨源**直连 3774
  //   （不再走 /api 代理）；鉴权 Cookie 为 SameSite=Strict，要求 web 与 api 同主机名
  //   （都用 localhost，勿混用 127.0.0.1）。
  const repoRoot = path.resolve(__dirname, '../..');
  const envDir = command === 'serve' ? repoRoot : __dirname;

  // ★ 防御：确保 VITE_API_BASE_URL 是合法的 API 根（带 /api 后缀）。
  //   背景：宿主/IDE 可能把 VITE_API_BASE_URL 注入到**进程环境**，而 Vite 解析环境
  //   变量时 process.env 的优先级高于 .env 文件（见 vite 的 loadEnv 实现）。
  //   若该值漏写 /api（如 http://localhost:3774），前端会把请求打到
  //   http://localhost:3774/projects（应 /api/projects）→ 404 / CORS 预检失败
  //   → 浏览器报 "网络错误: Failed to fetch"，症状隐蔽、极易误判为后端故障。
  //   这里统一规范化，并写回 process.env 使 import.meta.env 与 dev server 端一致。
  const rawApiBase = (
    process.env.VITE_API_BASE_URL ??
    loadEnv(mode, envDir, 'VITE_').VITE_API_BASE_URL ??
    ''
  ).trim();
  const apiBaseUrl = rawApiBase
    ? /\/api\/?$/.test(rawApiBase)
      ? rawApiBase.replace(/\/+$/, '')
      : `${rawApiBase.replace(/\/+$/, '')}/api`
    : '/api';
  if (rawApiBase && apiBaseUrl !== rawApiBase) {
    console.warn(
      `[vite] VITE_API_BASE_URL="${rawApiBase}" 缺少 /api 后缀，已自动规范化为 "${apiBaseUrl}"`,
    );
  }
  process.env.VITE_API_BASE_URL = apiBaseUrl;

  return {
    // 环境变量目录：dev=仓库根（与上面 loadEnv 的 envDir 一致），build=apps/web（Vite 默认）。
    // 让 import.meta.env.VITE_* 与 Vite 内置的 .env 解析都指向同一处。
    envDir,
    // 覆盖 import.meta.env.VITE_API_BASE_URL，确保运行时拿到规范化后的 API 根
    define: {
      'import.meta.env.VITE_API_BASE_URL': JSON.stringify(apiBaseUrl),
    },
    plugins: [
    react(),
    createHtmlPlugin({
      minify: false,
      inject: {
        tags: [
          {
            tag: 'meta',
            attrs: {
              name: 'referrer',
              content: 'strict-origin-when-cross-origin',
            },
            injectTo: 'head',
          },
          {
            tag: 'meta',
            attrs: {
              'http-equiv': 'Content-Security-Policy',
              content: [
                "default-src 'self'",
                "script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com",
                "style-src 'self' 'unsafe-inline' https://www.gstatic.com",
                "img-src 'self' data: https: blob:",
                "font-src 'self' data:",
                "connect-src 'self' http://localhost:* https: wss: ws:",
                "frame-src 'none'",
                "object-src 'none'",
                "base-uri 'self'",
              ].join('; '),
            },
            injectTo: 'head',
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // 三层拆分：共享包直连源码（与 tsconfig/vitest 三处一致）。
      // 字符串 alias 做前缀替换，故 `@novel-plugins/data-core/stores`
      // → `.../data-core/src/stores` 自动成立。
      '@novel-plugins/ui-graph': path.resolve(__dirname, '../plugins/shared/ui-graph/src'),
      '@novel-plugins/ui-kit': path.resolve(__dirname, '../plugins/shared/ui-kit/src'),
      '@novel-plugins/data-core': path.resolve(__dirname, '../plugins/shared/data-core/src'),
      // ★ 剥离实现时清理的悬空别名（原 3 条）：
      //     '@novel-plugins/auto-workbench/web'    → ../plugins/auto/workbench/web/index.tsx
      //     '@novel-plugins/auto-workbench/stores' → ../plugins/auto/workbench/stores/index.ts
      //     '@novel-plugins/auto-workbench'        → ../plugins/auto/workbench/web/index.tsx
      //   理由：auto 模块实现已移出仓库，三个目标路径已不存在，属**惰性腐化点**。
      //   kernel 内无任何静态 import 经这些别名解析（模块入口一律走构建期
      //   import.meta.glob，见 src/plugin/moduleEntries.ts 的 D44 说明），
      //   故删除对构建无影响；保留则会在将来被解析时报 ENOENT。
      //   ★ 刻意**不**清理 manual-workbench 的两条 —— 手写台仍在场，且需要它们。
      '@novel-plugins/manual-workbench/web': path.resolve(__dirname, '../plugins/manual/workbench/web/index.tsx'),
      '@novel-plugins/manual-workbench/stores': path.resolve(__dirname, '../plugins/manual/workbench/stores/index.ts'),
    },
  },
  server: {
    port: 5174,
    strictPort: true,
    headers: {
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    },
    proxy: {
      '/api': {
        target: 'http://localhost:3774',
        changeOrigin: true,
        secure: false,
        configure: (proxy) => {
          // 仅保留错误日志，减少高频请求日志输出
          proxy.on('error', (err) => {
            console.warn('[Vite Proxy] 连接失败:', err.message);
          });
        },
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false, // 生产构建关闭 sourcemap 减少体积
    // 关闭压缩体积报告，加速 CI；提升大依赖告警阈值，避免 @ant-design/plots 等噪音
    reportCompressedSize: false,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        // ★ 函数式 manualChunks：用 id 前缀匹配，解决 gsap/ScrollTrigger 等子路径漏配问题
        //   之前对象形式只能匹配精确包名，gsap/ScrollTrigger 会被切到独立小 chunk 增加请求数
        manualChunks(id) {
          if (id.includes('node_modules')) {
            // React 生态核心：react + react-dom + react-router + zustand + framer-motion + gsap
            //   + @xyflow/react + @ant-design/plots
            // ★ 这些包互相依赖形成循环（motion↔react, flow→charts→react→flow），
            //   拆分会导致 React exports 初始化失败（Cannot set properties of undefined (setting 'Activity')）
            //   和 TDZ 错误（Cannot access 'xx' before initialization），全部合并到 vendor-react 消除循环
            if (
              id.includes('react-router') ||
              id.includes('react-dom') ||
              /[\\/]react[\\/]/.test(id) ||
              id.includes('zustand') ||
              id.includes('framer-motion') ||
              id.includes('gsap') ||
              id.includes('@gsap/') ||
              id.includes('@xyflow/') ||
              id.includes('@ant-design/plots') ||
              id.includes('@ant-design/g-')
            ) {
              return 'vendor-react';
            }
            // Tiptap 编辑器（含 core/pm 子包）
            if (id.includes('@tiptap/')) {
              return 'vendor-editor';
            }
            // 图标库
            if (id.includes('lucide-react')) {
              return 'vendor-icons';
            }
            // 地图
            if (id.includes('leaflet')) {
              return 'vendor-map';
            }
            // 3D 图谱（three.js + d3-force-3d）
            if (id.includes('three') || id.includes('d3-force-3d')) {
              return 'vendor-three';
            }
            // 液态玻璃效果
            if (id.includes('liquid-glass-react')) {
              return 'vendor-glass';
            }
            // Markdown 渲染
            if (id.includes('react-markdown') || id.includes('remark-') || id.includes('micromark') || id.includes('mdast-')) {
              return 'vendor-markdown';
            }
            // d3 力导向
            if (id.includes('d3-force') || id.includes('d3-quadtree') || id.includes('d3-dispatch') || id.includes('d3-timer')) {
              return 'vendor-d3';
            }
            // 导出工具
            if (id.includes('html-to-image') || id.includes('dompurify')) {
              return 'vendor-export';
            }
            // 通用工具
            if (id.includes('nanoid')) {
              return 'vendor-utils';
            }
          }
        },
      },
    },
  },
  // 依赖预构建优化：显式指定大型依赖，减少首次启动扫描时间
  // ★ 补全大依赖，避免首次访问对应路由时触发 deps 重新打包导致 dev 卡顿
  optimizeDeps: {
    include: [
      'react',
      'react-dom',
      'react-router-dom',
      'zustand',
      'gsap',
      'gsap/ScrollTrigger',
      '@gsap/react',
      '@tiptap/react',
      '@tiptap/starter-kit',
      '@tiptap/core',
      'lucide-react',
      '@xyflow/react',
      'leaflet',
      'framer-motion',
      'three',
      'three/addons/controls/OrbitControls.js',
      'd3-force-3d',
      'd3-force',
      'd3-force',
      'react-markdown',
      'html-to-image',
      'dompurify',
    ],
  },
  };
});
