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

      const ctx = gsap.context(() => {
        gsap.timeline({ defaults: { ease: 'power3.out' } })
          .to('.landing-hero-eyebrow', { opacity: 1, y: 0, duration: 0.8, delay: 0.3 }, 0)
          .to('.landing-hero-title', { opacity: 1, y: 0, duration: 1 }, 0.35)
          .to('.landing-hero-subtitle', { opacity: 1, y: 0, duration: 0.9 }, 0.6)
          .to('.landing-hero-cta', { opacity: 1, y: 0, duration: 0.7 }, 0.85)
          .to('.landing-scroll-indicator', { opacity: 1, duration: 0.6 }, 1.15);

        ScrollTrigger.batch('.landing-section-label', {
          onEnter: (els) =>
            gsap.to(els, { opacity: 1, y: 0, stagger: 0.12, duration: 0.7 }),
          start: 'top 85%',
          once: true,
        });

        ScrollTrigger.batch('.landing-section-title', {
          onEnter: (els) =>
            gsap.to(els, { opacity: 1, y: 0, stagger: 0.12, duration: 0.85 }),
          start: 'top 82%',
          once: true,
        });

        ScrollTrigger.batch('.landing-section-desc', {
          onEnter: (els) =>
            gsap.to(els, { opacity: 1, y: 0, stagger: 0.12, duration: 0.7 }),
          start: 'top 80%',
          once: true,
        });

        ScrollTrigger.batch('.landing-divider', {
          onEnter: (els) =>
            gsap.to(els, { opacity: 1, scaleX: 1, stagger: 0.08, duration: 0.8, ease: 'power2.inOut' }),
          start: 'top 88%',
          once: true,
        });

        ScrollTrigger.batch('.landing-feature-card', {
          onEnter: (els) =>
            gsap.to(els, { opacity: 1, y: 0, stagger: 0.14, duration: 0.75, ease: 'power2.out' }),
          start: 'top 84%',
          once: true,
        });

        ScrollTrigger.batch('.landing-section-divider', {
          onEnter: (els) =>
            gsap.to(els, { opacity: 1, y: 0, duration: 0.6, ease: 'power2.out' }),
          start: 'top 90%',
          once: true,
        });

        ScrollTrigger.batch(['.landing-cta-title', '.landing-cta-subtitle', '.landing-cta-btn'], {
          onEnter: (els) =>
            gsap.to(els, { opacity: 1, y: 0, stagger: 0.15, duration: 0.75 }),
          start: 'top 82%',
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
          <span className="landing-hero-eyebrow">听风细雨</span>
          <h1 className="landing-hero-title">
            以笔为舟
            <br />
            <em>思绪如雨处</em>
          </h1>
          <p className="landing-hero-subtitle">
            为创作者打造沉浸式写作空间，让每一部作品都充满温度。
          </p>

          {/* Hero CTA */}
          <div className="landing-hero-cta">
            <button
              className="nm-btn-apple-primary"
              style={{ width: 180, height: 56, padding: 0, fontSize: 15 }}
              onClick={() => navigate('/bookshelf')}
            >
              开始创作
            </button>
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

      {/* ===== Features Section ===== */}
      <section className="landing-features-section">
        <div className="landing-section-inner">
          <p className="landing-section-label">功能</p>
          <h2 className="landing-section-title">为创作者而生</h2>
          <p className="landing-section-desc">从构思到完稿，全流程陪伴</p>
          <div className="landing-divider" />

          <div className="landing-features-grid">
            {features.map((feat) => (
              <article key={feat.number} className="landing-feature-card">
                <span className="landing-feature-number">{feat.number}</span>
                <h3 className="landing-feature-title">{feat.title}</h3>
                <p className="landing-feature-desc">{feat.desc}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* ===== Section Divider ===== */}
      <div className="landing-section-divider" aria-hidden="true">
        <div className="dot" />
        <div className="line" />
        <div className="dot" />
      </div>

      {/* ===== CTA Section ===== */}
      <section className="landing-cta-section">
        <div className="landing-cta-glow" aria-hidden="true" />
        <div className="landing-cta-content">
          <h2 className="landing-cta-title">
            开始写作
            <br />
            <em>你的故事</em>
          </h2>
          <p className="landing-cta-subtitle">
            每一部伟大作品都始于第一个字。
          </p>

          {/* Bottom CTA */}
          <div className="landing-cta-btn">
            <button
              className="nm-btn-apple-primary"
              style={{ width: 200, height: 60, padding: 0, fontSize: 16 }}
              onClick={() => navigate('/bookshelf')}
            >
              开始创作
            </button>
          </div>
        </div>
      </section>

      {/* ===== Footer ===== */}
      <footer className="landing-footer">
        <span className="landing-footer-brand">听风细雨</span>
        <span>&copy; {new Date().getFullYear()}</span>
      </footer>
    </div>
  );
}
