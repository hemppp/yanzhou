/**
 * 砚舟 GSAP 动画工具模块
 * 统一注册插件、全局配置、常用动画预设
 */
import { gsap } from 'gsap';
import { useGSAP } from '@gsap/react';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

// 注册插件
gsap.registerPlugin(ScrollTrigger);

// 全局默认值 — Notion 风格: 柔和、快速、不抢戏
// 注：willChange 不能放在 gsap.defaults 里（GSAP 会把它当成可动画属性，
// 触发 "Missing plugin" 警告）。需要在元素上设置时直接写 inline style 或 CSS class。
gsap.defaults({
  duration: 0.4,
  ease: 'power2.out',
});

// ===================== 预设动画 =====================

/** 页面入场 — 淡入上移 */
export function pageEnter(selector: string) {
  return gsap.from(selector, {
    opacity: 0,
    y: 16,
    duration: 0.5,
    ease: 'power2.out',
    stagger: 0.06,
    overwrite: 'auto',
  });
}

/** 卡片交错入场 — 用于书架、列表 */
export function staggerCards(selector: string, _onComplete?: () => void) {
  return gsap.from(selector, {
    opacity: 0,
    y: 24,
    scale: 0.96,
    duration: 0.45,
    ease: 'power2.out',
    stagger: 0.08,
    clearProps: 'all',
    overwrite: 'auto',
  });
}

/** Modal 弹窗入场 */
export function modalEnter(modalEl: Element, backdropEl?: Element) {
  const tl = gsap.timeline({ overwrite: 'auto' });
  if (backdropEl) {
    tl.from(backdropEl, { opacity: 0, duration: 0.2 });
  }
  tl.from(modalEl, {
    opacity: 0,
    scale: 0.92,
    y: 12,
    duration: 0.35,
    ease: 'bounceEase',
  });
  return tl;
}

/** Modal 弹窗退出 */
export function modalExit(modalEl: Element, backdropEl?: Element) {
  const tl = gsap.timeline();
  tl.to(modalEl, {
    opacity: 0,
    scale: 0.95,
    y: 8,
    duration: 0.2,
    ease: 'power2.in',
  });
  if (backdropEl) {
    tl.to(backdropEl, { opacity: 0, duration: 0.15 }, '-=0.1');
  }
  return tl;
}

/** 侧边栏章节列表交错入场 */
export function chapterListEnter(selector: string) {
  return gsap.from(selector, {
    opacity: 0,
    x: -12,
    duration: 0.3,
    ease: 'power2.out',
    stagger: 0.04,
    // ★ 仅清除动画属性，保留元素原本内联 style 中的 borderRadius 等样式
    // （之前用 'all' 会把 borderRadius:28 等内联样式一起清掉，导致章节项变回方形）
    clearProps: 'opacity,transform',
  });
}

/** 按钮微交互 — 按下回弹 */
export function buttonPulse(el: Element) {
  return gsap.to(el, {
    scale: 0.95,
    duration: 0.1,
    ease: 'power2.in',
    yoyo: true,
    repeat: 1,
  });
}

/** 数字递增动画 */
export function countUp(
  el: Element,
  endValue: number,
  duration: number = 1.2,
  prefix: string = '',
  suffix: string = ''
) {
  const obj = { value: 0 };
  return gsap.to(obj, {
    value: endValue,
    duration,
    ease: 'power2.out',
    onUpdate: () => {
      (el as HTMLElement).textContent = `${prefix}${Math.round(obj.value).toLocaleString()}${suffix}`;
    },
  });
}

/** Toast 通知入场 */
export function toastEnter(el: Element) {
  return gsap.from(el, {
    opacity: 0,
    y: -20,
    x: 20,
    scale: 0.9,
    duration: 0.35,
    ease: 'bounceEase',
  });
}

/** 滚动触发批量入场 */
export function scrollBatchEnter(selector: string) {
  return ScrollTrigger.batch(selector, {
    onEnter: (elements) => {
      gsap.from(elements, {
        opacity: 0,
        y: 30,
        stagger: 0.1,
        duration: 0.5,
        ease: 'power2.out',
        clearProps: 'all',
      });
    },
    start: 'top 85%',
    once: true,
  });
}

export const springEase = "elastic.out(1, 0.4)";
export const smoothEase = "power3.out";
export const bounceEase = "back.out(1.7)";

export function pageTransition(container: Element) {
  return gsap.from(container, {
    opacity: 0,
    y: 12,
    duration: 0.5,
    ease: "power3.out",
    clearProps: "opacity",
  });
}

export function glassEnter(el: gsap.TweenTarget, options?: { duration?: number; delay?: number }) {
  var d = (options && options.duration) || 0.5;
  var delay = (options && options.delay) || 0;
  return gsap.fromTo(el,
    { opacity: 0, backdropFilter: "blur(0px) saturate(100%)" },
    { opacity: 1, backdropFilter: "blur(14px) saturate(140%)",
      duration: d, delay: delay, ease: "power3.out" }
  );
}

export { gsap, useGSAP, ScrollTrigger };
