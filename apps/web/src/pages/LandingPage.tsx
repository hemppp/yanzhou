import { useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { gsap, useGSAP, ScrollTrigger } from '@/utils/gsap';

import '@/styles/landing.css';

const features = [
  {
    number: '01',
    title: '沉浸式写作',
    desc: '专注的编辑体验，AI 智能相伴，实时节奏引导，让写作行云流水般自然。',
  },
  {
    number: '02',
    title: '知识图谱',
    desc: '角色关系网、时间线、物品追踪、地点图谱，让复杂叙事井然有序。',
  },
  {
    number: '03',
    title: '伏笔与一致性',
    desc: '自动提取、校验、状态追踪、多维关联，让每一处伏笔都恰到好处。',
  },
];
export function LandingPage() {
  const navigate = useNavigate();
  const pageRef = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      if (!pageRef.current) return;

      // ★ 2026-10-30（P3）：动效预算收敛。
      //
      // 原状：Hero 一条 6 拍的时间线 + **7 个** ScrollTrigger.batch，
      //   分别监听 section-label / title / desc / divider / feature-card /
      //   section-divider / cta —— 也就是**每个区块各播一遍淡入上移**。
      //   这正是生成式页面的默认动作（规范 §6.3 明确列为废止项）：
      //   滚动时屏幕上永远有东西在动，注意力被切成碎片，反而没有重点。
      //
      // 现方案（只保留两处）：
      //   1. Hero 一次编排 —— 这是**唯一**该有"开场"的地方（首屏）。
      //   2. 功能区编号纵列用**一次** batch（而不是三次：title/desc/card 各一次）。
      //   CTA 与分隔线不再做入场 —— 它们本来就该在那里。
      const ctx = gsap.context(() => {
        gsap.timeline({ defaults: { ease: 'power3.out' } })
          .to('.landing-hero-title', { opacity: 1, y: 0, duration: 0.9 }, 0.1)
          .to('.landing-hero-subtitle', { opacity: 1, y: 0, duration: 0.7 }, 0.35)
          .to('.landing-cta-row', { opacity: 1, y: 0, duration: 0.6 }, 0.55)
          .to('.landing-preview', { opacity: 1, y: 0, duration: 0.8 }, 0.65)
          .to('.landing-scroll-indicator', { opacity: 1, duration: 0.5 }, 0.9);

        // 唯一一处滚动入场：三条说明依次浮现（stagger 让"清单"关系被看见）
        ScrollTrigger.batch('.landing-feature-row', {
          onEnter: (els) =>
            gsap.to(els, { opacity: 1, y: 0, stagger: 0.1, duration: 0.55, ease: 'power2.out' }),
          start: 'top 88%',
          once: true,
        });
      }, pageRef);

      return () => ctx.revert();
    },
    { scope: pageRef, dependencies: [] }
  );


  return (
    <div ref={pageRef} className="landing-page">
      {/* 液态玻璃环境背景由 App.tsx 全局挂载 */}

      {/* ===== 顶部导航（2026-10-29 新增）=====
          此前落地页没有任何导航：访客（尤其已注册的）在首页找不到「登录」。
          左侧是字标，中间是章节锚点，右侧是登录 + 主行动。 */}
      <nav className="landing-nav" aria-label="站点导航">
        <div className="landing-nav-inner">
          <div className="landing-nav-brand">
            砚舟<small>伴写小说工具</small>
          </div>
          <div className="landing-nav-links">
            <button
              type="button"
              className="landing-nav-link"
              onClick={() => document.getElementById('landing-features')?.scrollIntoView({ behavior: 'smooth' })}
            >
              功能
            </button>
            <button
              type="button"
              className="landing-nav-link"
              onClick={() => document.getElementById('landing-start')?.scrollIntoView({ behavior: 'smooth' })}
            >
              开始使用
            </button>
          </div>
          <div className="landing-nav-actions">
            <button type="button" className="landing-nav-link" onClick={() => navigate('/login')}>
              登录
            </button>
            <button
              type="button"
              className="nm-btn-apple-primary"
              style={{ height: 32 }}
              onClick={() => navigate('/bookshelf')}
            >
              开始创作
            </button>
          </div>
        </div>
      </nav>

      {/* ===== Hero Section ===== */}
      <section className="landing-hero">
        {/* 装饰性墨点 */}
        <div className="landing-hero-inkdot" aria-hidden="true" />
        <div className="landing-hero-inkdot-2" aria-hidden="true" />

        {/* 远山 SVG 装饰背景 */}
        <div className="landing-hero-mountains" aria-hidden="true">
          <svg viewBox="0 0 1400 200" preserveAspectRatio="xMidYMax meet" fill="none" xmlns="http://www.w3.org/2000/svg">
            {/* 远山层 1 — 最远（fill 由 landing.css 的 class 控制：SVG 演示属性不支持 var()） */}
            <path className="mountain-layer-1" d="M0 200 L150 60 L260 130 L380 40 L500 110 L620 20 L750 90 L880 50 L1000 100 L1100 30 L1250 80 L1400 0 L1400 200 Z"
              opacity="0.08" />
            {/* 远山层 2 — 中间 */}
            <path className="mountain-layer-2" d="M0 200 L100 100 L220 150 L340 80 L480 130 L600 60 L740 110 L860 40 L1020 120 L1180 50 L1320 100 L1400 70 L1400 200 Z"
              opacity="0.06" />
            {/* 云雾 */}
            <ellipse cx="700" cy="180" rx="500" ry="40" opacity="0.08" />
            <ellipse cx="350" cy="170" rx="300" ry="30" opacity="0.06" />
            <ellipse cx="1050" cy="185" rx="350" ry="35" opacity="0.07" />
          </svg>
        </div>

        <div className="landing-hero-content">
          {/* ★ 2026-10-30（P3）：删掉 eyebrow（`— 砚舟 —`）。
              它是「monospace + 展开字距 + 全大写」那一套，与产品内的 .mc-eyebrow
              是同一个指纹的两份拷贝，也是生成式落地页最典型的开场动作。
              品牌名已经在导航左上角出现过一次，这里再报一次不提供任何信息。 */}
          <h1 className="landing-hero-title">
            以笔为舟
            <br />
            思绪如雨处
          </h1>
          {/* ★ 去掉副标题。原文「为创作者打造沉浸式写作空间，让每一部作品都充满温度」
              是两句空话：没有主语的形容词堆叠，读完不知道这产品具体做什么。
              真正的说明交给下面那块**产品预览** —— 它直接显示界面长什么样。
              文案的作用是减少不确定，不是烘托气氛。 */}
          <p className="landing-hero-subtitle">
            一个本地运行的小说写作台：正文、人物、伏笔、时间线放在同一处，
            AI 陪你写，但不替你写。
          </p>

          {/* Hero CTA：主行动 + 一个次级出口。
              原来只有"开始创作"一个按钮，新访客没有别的可点（想先看看都不行）。 */}
          <div className="landing-cta-row">
            <button
              className="nm-btn-apple-primary landing-cta-lg"
              onClick={() => navigate('/bookshelf')}
            >
              开始创作
            </button>
            <button
              type="button"
              className="landing-cta-ghost"
              onClick={() => document.getElementById('landing-features')?.scrollIntoView({ behavior: 'smooth' })}
            >
              看看有什么
            </button>
          </div>

          {/* 产品预览：让访客看见"它长什么样"，而不是只读一句口号。
              结构与真实工作台一致（分区竖栏 / 分栏线 / 版心正文），
              但内容是静态示意 —— 它不接 store、不调 API。 */}
          <div className="landing-preview" aria-label="砚舟写作台界面预览">
            <div className="landing-preview-bar" aria-hidden="true">
              <span className="landing-preview-dot" />
              <span className="landing-preview-dot" />
              <span className="landing-preview-dot" />
              <span className="landing-preview-title">雨夜行舟 · 第一章 夜雨</span>
            </div>
            <div className="landing-preview-body" aria-hidden="true">
              <div className="landing-preview-rail">
                <div className="landing-preview-rail-group">
                  <span className="landing-preview-rail-label">写作</span>
                  <span className="landing-preview-rail-item is-on" />
                  <span className="landing-preview-rail-item" />
                </div>
                <div className="landing-preview-rail-group">
                  <span className="landing-preview-rail-label">资料</span>
                  <span className="landing-preview-rail-item" />
                  <span className="landing-preview-rail-item" />
                  <span className="landing-preview-rail-item" />
                </div>
                <div className="landing-preview-rail-group">
                  <span className="landing-preview-rail-label">工具</span>
                  <span className="landing-preview-rail-item" />
                </div>
              </div>
              <div className="landing-preview-page">
                <div className="landing-preview-h1">第一章　夜雨</div>
                <div className="landing-preview-meta">1,284 字 · 已保存 · 本章 D1</div>
                <div className="landing-preview-prose">
                  <p>雨是入夜后开始的。起初只是窗玻璃上一层薄雾，后来连成线，把整条巷子洗成一片发亮的黑。</p>
                  <p>
                    他放下伞，没有推门。檐下的水一滴一滴砸在石阶上
                    <span className="landing-preview-caret" />
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="landing-scroll-indicator">
          <div className="landing-scroll-line" />
          <span className="landing-scroll-text">了解更多</span>
        </div>
      </section>

      {/* ===== Section Divider ===== */}
      <div className="landing-section-divider" aria-hidden="true">
        <div className="dot" />
        <div className="line" />
        <div className="dot" />
      </div>

      {/* ===== Features Section =====
          ★ 2026-10-30（P3）：从「三张并排圆角卡」改为「编号纵列」。

          为什么改（两条独立理由）：
          1. **卡片是错的容器**。三张同款圆角卡 + 同款柔和投影 + 各自 2+1 断行，
             是 SaaS 模板最标准的陈列法。这里的内容是**三条并列的说明**，
             不是三个可点击的实体 —— 卡片在暗示"点我"，但它们不可点。
          2. **编号原本不合法，现在合法了**。旧版在三张并排卡上打 01/02/03，
             但它们没有先后关系，编号只是装饰。改成纵列之后，编号读作
             「清单第 N 条」，是真实的结构信息 —— 这是 §7 反模式 #4 的正确用法。

          同时删掉 `landing-section-label`（「功能」）—— 又一处眉标。
          章节标题自己已经说了它是什么。 */}
      <section className="landing-features-section" id="landing-features">
        <div className="landing-section-inner">
          <h2 className="landing-section-title">它替你做三件事</h2>
          <p className="landing-section-desc">
            不是三个功能模块，是写作时反复遇到的三类麻烦。
          </p>

          <ol className="landing-feature-list">
            {features.map((feat) => (
              <li key={feat.number} className="landing-feature-row">
                <span className="landing-feature-number" aria-hidden="true">
                  {feat.number}
                </span>
                <div className="landing-feature-body">
                  <h3 className="landing-feature-title">{feat.title}</h3>
                  <p className="landing-feature-desc">{feat.desc}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* ===== Section Divider ===== */}
      <div className="landing-section-divider" aria-hidden="true">
        <div className="dot" />
        <div className="line" />
        <div className="dot" />
      </div>

      {/* ===== CTA Section ===== */}
      <section className="landing-cta-section" id="landing-start">
        <div className="landing-cta-glow" aria-hidden="true" />
        <div className="landing-cta-content">
          <h2 className="landing-cta-title">
            开始写
            <br />
            你的故事
          </h2>
          <p className="landing-cta-subtitle">
            不用先想清楚。写下来，它会慢慢清楚。
          </p>

          {/* Bottom CTA */}
          <div className="landing-cta-btn">
            <button
              className="nm-btn-apple-primary landing-cta-lg"
              onClick={() => navigate('/bookshelf')}
            >
              开始创作
            </button>
          </div>
        </div>
      </section>

      {/* ===== Footer ===== */}
      <footer className="landing-footer">
        <span className="landing-footer-brand">砚舟</span>
        <span className="landing-footer-note">本地优先 · 数据存在你自己的机器上</span>
        <span>&copy; {new Date().getFullYear()}</span>
      </footer>
    </div>
  );
}
