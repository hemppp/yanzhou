import { useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  type SimulationNodeDatum3D,
} from 'd3-force-3d';
import type { Node, Edge } from '@xyflow/react';

// ============================================================
// Graph3D — 知识图谱 3D 浏览模式
//
// 方案：three.js（imperative，无 React 绑定）+ d3-force-3d
//   · 节点：MeshLambertMaterial 球体（有明暗立体感）+ Canvas 中文标签 Sprite
//   · 边：细线 + hover 高亮 + 关系类型标签
//   · 交互：OrbitControls 旋转/缩放/平移，Raycaster 拾取 hover/click
//   · 风格：雾效水墨透视、淡色星空点、半透明球
//   · 降级：WebGL 不可用时显示提示（2D 模式不受影响）
//
// 注意：本组件不读取 @xyflow/react 的 node.position（2D 布局），
//       3D 坐标由内部 d3-force-3d 仿真独立驱动，与 2D 互不干扰。
// ============================================================

export interface Graph3DHandle {
  /** 导出当前 3D 视图为 PNG dataURL（无则返回 null） */
  exportPNG: () => string | null;
}

export interface Graph3DProps {
  nodes: Node[];
  edges: Edge[];
  getNodeColor?: (node: Node) => string;
  /** 点击节点（event 由 3D 内部处理，业务方通常只用 node） */
  onNodeClick?: (node: Node) => void;
  onNodeHover?: (node: Node | null) => void;
  onBackgroundClick?: () => void;
  ref?: React.Ref<Graph3DHandle>;
}

interface SimNode3D extends SimulationNodeDatum3D {
  id: string;
  r: number;
  color: string;
  label: string;
  source: Node; // 原 @xyflow/react 节点引用，用于回调
  mesh: THREE.Mesh;
  labelSprite: THREE.Sprite;
  halo: THREE.Sprite | null;
}

interface SimLink3D {
  /** forceLink 初始化必需：节点 id（字符串）或节点对象 */
  source: string;
  target: string;
  sourceId: string;
  targetId: string;
  color: string;
  label: string;
  line: THREE.Line;
  labelSprite: THREE.Sprite;
}

const NODE_LABEL_FONT =
  '600 14px "Noto Serif SC","Source Han Serif SC","PingFang SC","Microsoft YaHei",sans-serif';

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** 生成节点中文标签纹理（白底圆角 + 节点色文字） */
function makeLabelTexture(text: string, color: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    // 极端兜底：返回 1x1 透明纹理
    return new THREE.CanvasTexture(document.createElement('canvas'));
  }
  ctx.font = NODE_LABEL_FONT;
  const textWidth = ctx.measureText(text).width;
  const width = Math.max(32, Math.ceil(textWidth + 18));
  const height = 28;
  canvas.width = width;
  canvas.height = height;

  ctx.font = NODE_LABEL_FONT;
  roundRectPath(ctx, 0, 0, width, height, 9);
  ctx.fillStyle = 'rgba(255,255,255,0.88)';
  ctx.fill();
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, width / 2, height / 2 + 1);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** 生成选中光环纹理（圆环 + 辉光） */
function makeHaloTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.clearRect(0, 0, 128, 128);
    ctx.strokeStyle = 'rgba(35,131,199,0.9)';
    ctx.lineWidth = 6;
    ctx.shadowColor = 'rgba(35,131,199,0.8)';
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.arc(64, 64, 52, 0, Math.PI * 2);
    ctx.stroke();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** 生成关系标签纹理（小圆角底 + 关系色文字） */
function makeEdgeLabelTexture(text: string, color: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return new THREE.CanvasTexture(document.createElement('canvas'));
  }
  ctx.font = '500 11px "PingFang SC","Microsoft YaHei",sans-serif';
  const textWidth = ctx.measureText(text).width;
  const width = Math.max(24, Math.ceil(textWidth + 14));
  const height = 20;
  canvas.width = width;
  canvas.height = height;
  ctx.font = '500 11px "PingFang SC","Microsoft YaHei",sans-serif';
  roundRectPath(ctx, 0, 0, width, height, 8);
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.fill();
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, width / 2, height / 2 + 1);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function getEdgeEndpoints(edge: Edge): { sourceId: string; targetId: string } {
  const sourceId = typeof edge.source === 'string' ? edge.source : String((edge.source as { id?: string } | null)?.id ?? '');
  const targetId = typeof edge.target === 'string' ? edge.target : String((edge.target as { id?: string } | null)?.id ?? '');
  return { sourceId, targetId };
}

/** 随机球面初始位置（避免所有节点挤在原点起步） */
function randomSpherePosition(seedIndex: number): THREE.Vector3 {
  const phi = Math.acos(2 * Math.random() - 1);
  const theta = 2 * Math.PI * Math.random();
  const radius = 150 + (seedIndex % 12) * 16;
  return new THREE.Vector3(
    radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.sin(phi) * Math.sin(theta) * 0.7,
    radius * Math.cos(phi),
  );
}

export function Graph3D({ nodes, edges, getNodeColor, onNodeClick, onNodeHover, onBackgroundClick, ref }: Graph3DProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [webglFailed, setWebglFailed] = useState(false);
  const [autoRotate, setAutoRotate] = useState(true);
  const [viewReady, setViewReady] = useState(false);

  // 场景对象全部存 ref，React 渲染与 three 世界解耦
  const sceneRef = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    raycaster: THREE.Raycaster;
    nodes: SimNode3D[];
    links: SimLink3D[];
    pointerNdc: THREE.Vector2;
    raf: number;
    disposables: Array<() => void>;
  } | null>(null);

  const hoverIdRef = useRef<string | null>(null);
  const selectedIdRef = useRef<string | null>(null);

  // 暴露导出能力
  useImperativeHandle(ref, () => ({
    exportPNG: () => sceneRef.current?.renderer.domElement.toDataURL('image/png') ?? null,
  }));

  // 构造 three 数据（仅当节点/边的结构变化时重建）
  const buildKey = useMemo(
    () =>
      nodes.map((n) => `${n.id}:${String(n.data?.label ?? '')}:${String(n.data?.color ?? '')}:${String(n.data?.size ?? '')}`).join('|') +
      ';;' +
      edges.map((e) => `${e.id}:${getEdgeEndpoints(e).sourceId}>${getEdgeEndpoints(e).targetId}:${String(e.data?.color ?? '')}`).join('|'),
    [nodes, edges],
  );

  // 初始化 three 场景（一次性）
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        preserveDrawingBuffer: true, // 支持导出 PNG
        powerPreference: 'high-performance',
      });
    } catch {
      setWebglFailed(true);
      return;
    }
    setWebglFailed(false);
    setViewReady(true);

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0xf4f5f7, 480, 1150);

    const camera = new THREE.PerspectiveCamera(50, container.clientWidth / Math.max(1, container.clientHeight), 0.1, 3000);
    camera.position.set(0, 140, 620);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 160;
    controls.maxDistance = 1400;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.5;
    controls.target.set(0, 0, 0);

    const raycaster = new THREE.Raycaster();
    const pointerNdc = new THREE.Vector2();

    // 灯光：环境 + 方向（让球体有立体明暗）
    scene.add(new THREE.AmbientLight(0xffffff, 1.15));
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.85);
    dirLight.position.set(220, 420, 320);
    scene.add(dirLight);

    // 星空背景点（淡青色，水墨点缀）
    const starPositions: number[] = [];
    for (let i = 0; i < 240; i += 1) {
      const v = randomSpherePosition(i % 19).multiplyScalar(1.6 + (i % 7) * 0.12);
      starPositions.push(v.x, v.y * 1.6, v.z);
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.Float32BufferAttribute(starPositions, 3));
    const starMat = new THREE.PointsMaterial({
      color: 0x9db8c6,
      size: 2.2,
      transparent: true,
      opacity: 0.4,
      sizeAttenuation: true,
      depthWrite: false,
    });
    const stars = new THREE.Points(starGeo, starMat);
    scene.add(stars);

    // —— 节点 ——
    const nodeById = new Map<string, Node>();
    for (const n of nodes) nodeById.set(n.id, n);

    const simNodes: SimNode3D[] = [];
    const nodeMeshes: THREE.Mesh[] = [];
    const haloTexture = makeHaloTexture();
    const disposables: Array<() => void> = [() => haloTexture.dispose()];

    nodes.forEach((n, index) => {
      const label = String(n.data?.label ?? n.id);
      const color = getNodeColor?.(n) ?? String(n.data?.color ?? '#6b7280');
      const size = Number(n.data?.size ?? 30);
      const r = Math.max(8, (size / 2) * 0.6);
      const start = randomSpherePosition(index);

      const geometry = new THREE.SphereGeometry(r, 28, 28);
      const material = new THREE.MeshLambertMaterial({
        color: new THREE.Color(color),
        transparent: true,
        opacity: 0.94,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(start.x, start.y, start.z);
      mesh.userData.nodeId = n.id;
      scene.add(mesh);
      nodeMeshes.push(mesh);
      disposables.push(() => {
        geometry.dispose();
        material.dispose();
      });

      // 中文标签
      const labelTexture = makeLabelTexture(label, color);
      const spriteMat = new THREE.SpriteMaterial({ map: labelTexture, transparent: true, depthWrite: false });
      const sprite = new THREE.Sprite(spriteMat);
      const tw = labelTexture.image.width;
      const th = labelTexture.image.height;
      sprite.scale.set(tw * 0.058, th * 0.058, 1);
      sprite.position.set(start.x, start.y + r + 16, start.z);
      scene.add(sprite);
      disposables.push(() => {
        labelTexture.dispose();
        spriteMat.dispose();
      });

      // 选中光环（默认隐藏）
      const haloMat = new THREE.SpriteMaterial({ map: haloTexture, transparent: true, depthWrite: false, opacity: 0.95 });
      const halo = new THREE.Sprite(haloMat);
      halo.scale.set(r * 3.2, r * 3.2, 1);
      halo.visible = false;
      scene.add(halo);
      disposables.push(() => haloMat.dispose());

      simNodes.push({
        id: n.id,
        x: start.x,
        y: start.y,
        z: start.z,
        r,
        color,
        label,
        source: n,
        mesh,
        labelSprite: sprite,
        halo,
      });
    });

    // —— 边 ——
    const simLinks: SimLink3D[] = [];
    for (const edge of edges) {
      const { sourceId, targetId } = getEdgeEndpoints(edge);
      if (!nodeById.has(sourceId) || !nodeById.has(targetId)) continue;
      const color = String(edge.data?.color ?? '#6b7280');
      const label = String(edge.label ?? '');

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0], 3));
      const material = new THREE.LineBasicMaterial({
        color: new THREE.Color(color),
        transparent: true,
        opacity: 0.28,
        depthWrite: false,
      });
      const line = new THREE.Line(geometry, material);
      scene.add(line);

      // 关系标签（默认隐藏，hover 节点时显示）
      const edgeLabelTexture = makeEdgeLabelTexture(label || '关系', color);
      const edgeLabelMat = new THREE.SpriteMaterial({ map: edgeLabelTexture, transparent: true, depthWrite: false, opacity: 0.95 });
      const edgeLabel = new THREE.Sprite(edgeLabelMat);
      const ew = edgeLabelTexture.image.width;
      const eh = edgeLabelTexture.image.height;
      edgeLabel.scale.set(ew * 0.052, eh * 0.052, 1);
      edgeLabel.visible = false;
      scene.add(edgeLabel);

      disposables.push(() => {
        geometry.dispose();
        material.dispose();
        edgeLabelTexture.dispose();
        edgeLabelMat.dispose();
      });

      simLinks.push({
        source: sourceId,
        target: targetId,
        sourceId,
        targetId,
        color,
        label,
        line,
        labelSprite: edgeLabel,
      });
    }

    // —— d3-force-3d 力导向仿真（导出名不带 3D 后缀，内部即三维实现） ——
    const simulation = forceSimulation<SimNode3D>(simNodes)
      .force(
        'link',
        forceLink<SimNode3D, SimLink3D>(simLinks)
          .id((d) => d.id)
          .distance(185)
          .strength(0.32),
      )
      .force('charge', forceManyBody().strength(-640))
      .force('center', forceCenter(0, 0, 0).strength(0.09))
      .force(
        'collide',
        forceCollide<SimNode3D>()
          .radius((d) => d.r + 14)
          .strength(0.85),
      )
      .alphaDecay(0.028)
      .velocityDecay(0.42);

    // —— 渲染循环 ——
    const animate = () => {
      const ctx = sceneRef.current;
      if (!ctx) return;
      ctx.raf = requestAnimationFrame(animate);

      ctx.controls.update();

      // 节点位置 + 标签跟随
      for (const sn of ctx.nodes) {
        sn.mesh.position.set(sn.x ?? 0, sn.y ?? 0, sn.z ?? 0);
        sn.labelSprite.position.set(sn.x ?? 0, (sn.y ?? 0) + sn.r + 18, sn.z ?? 0);
        if (sn.halo) {
          sn.halo.position.set(sn.x ?? 0, (sn.y ?? 0) + sn.r + 6, sn.z ?? 0);
          sn.halo.visible = selectedIdRef.current === sn.id || hoverIdRef.current === sn.id;
        }
      }

      // 边位置 + 中点标签
      const nodePos = new Map<string, { x: number; y: number; z: number }>();
      for (const sn of ctx.nodes) nodePos.set(sn.id, { x: sn.x ?? 0, y: sn.y ?? 0, z: sn.z ?? 0 });

      const hovered = hoverIdRef.current;
      const selected = selectedIdRef.current;
      for (const link of ctx.links) {
        const a = nodePos.get(link.sourceId);
        const b = nodePos.get(link.targetId);
        if (!a || !b) continue;
        const attr = link.line.geometry.attributes.position as THREE.BufferAttribute;
        attr.setXYZ(0, a.x, a.y, a.z);
        attr.setXYZ(1, b.x, b.y, b.z);
        attr.needsUpdate = true;
        link.line.geometry.computeBoundingSphere();

        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        const mz = (a.z + b.z) / 2;
        link.labelSprite.position.set(mx, my + 10, mz);

        const adjacentToHover = !!hovered && (link.sourceId === hovered || link.targetId === hovered);
        const adjacentToSelected = !!selected && (link.sourceId === selected || link.targetId === selected);
        const active = adjacentToHover || adjacentToSelected;
        const mat = link.line.material as THREE.LineBasicMaterial;
        mat.opacity = active ? 0.92 : 0.28;
        if (active) {
          mat.color.offsetHSL(0, 0.05, 0.16);
        } else {
          mat.color.set(link.color);
        }
        // hover 节点时显示相邻关系标签；selected 时不显示（避免视觉噪音）
        link.labelSprite.visible = adjacentToHover && !selected;
      }

      ctx.renderer.render(ctx.scene, ctx.camera);
    };

    // —— 尺寸自适应 ——
    const resize = () => {
      const ctx = sceneRef.current;
      if (!ctx || !container) return;
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (w === 0 || h === 0) return;
      ctx.renderer.setSize(w, h);
      ctx.camera.aspect = w / h;
      ctx.camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);

    // —— 交互 ——
    const onPointerMove = (e: PointerEvent) => {
      const ctx = sceneRef.current;
      if (!ctx || !container) return;
      const rect = container.getBoundingClientRect();
      ctx.pointerNdc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      ctx.pointerNdc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      ctx.raycaster.setFromCamera(ctx.pointerNdc, ctx.camera);
      const hits = ctx.raycaster.intersectObjects(ctx.nodes.map((n) => n.mesh), false);
      const hitId = hits[0] ? (hits[0].object.userData.nodeId as string | undefined) ?? null : null;
      if (hitId !== hoverIdRef.current) {
        hoverIdRef.current = hitId;
        onNodeHover?.(hitId ? nodeById.get(hitId) ?? null : null);
      }
    };
    const onPointerLeave = () => {
      if (hoverIdRef.current !== null) {
        hoverIdRef.current = null;
        onNodeHover?.(null);
      }
    };

    let downX = 0;
    let downY = 0;
    let downTime = 0;
    const onPointerDown = (e: PointerEvent) => {
      downX = e.clientX;
      downY = e.clientY;
      downTime = Date.now();
    };
    const onPointerUp = (e: PointerEvent) => {
      const ctx = sceneRef.current;
      if (!ctx || !container) return;
      const dx = e.clientX - downX;
      const dy = e.clientY - downY;
      const isClick = Math.hypot(dx, dy) < 6 && Date.now() - downTime < 500;
      if (!isClick) return;
      const rect = container.getBoundingClientRect();
      ctx.pointerNdc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      ctx.pointerNdc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      ctx.raycaster.setFromCamera(ctx.pointerNdc, ctx.camera);
      const hits = ctx.raycaster.intersectObjects(ctx.nodes.map((n) => n.mesh), false);
      if (hits[0]) {
        const hitNodeId = hits[0].object.userData.nodeId as string | undefined;
        if (hitNodeId) {
          selectedIdRef.current = selectedIdRef.current === hitNodeId ? null : hitNodeId;
          const node = nodeById.get(hitNodeId);
          if (node) onNodeClick?.(node);
          return;
        }
      }
      // 点击空白：取消选中
      selectedIdRef.current = null;
      onBackgroundClick?.();
    };

    const dom = renderer.domElement;
    dom.style.width = '100%';
    dom.style.height = '100%';
    dom.style.display = 'block';
    dom.style.touchAction = 'none';
    container.appendChild(dom);

    ro.observe(container);
    dom.addEventListener('pointermove', onPointerMove);
    dom.addEventListener('pointerleave', onPointerLeave);
    dom.addEventListener('pointerdown', onPointerDown);
    dom.addEventListener('pointerup', onPointerUp);

    // 自动旋转：用户交互后停止
    const stopAutoRotate = () => {
      controls.autoRotate = false;
      setAutoRotate(false);
    };
    controls.addEventListener('start', stopAutoRotate);

    // prefers-reduced-motion：关闭自动旋转
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      controls.autoRotate = false;
      setAutoRotate(false);
    }

    sceneRef.current = {
      renderer,
      scene,
      camera,
      controls,
      raycaster,
      nodes: simNodes,
      links: simLinks,
      pointerNdc,
      raf: 0,
      disposables,
    };
    sceneRef.current.raf = requestAnimationFrame(animate);
    resize();

    return () => {
      cancelAnimationFrame(sceneRef.current?.raf ?? 0);
      simulation.stop();
      controls.removeEventListener('start', stopAutoRotate);
      controls.dispose();
      ro.disconnect();
      dom.removeEventListener('pointermove', onPointerMove);
      dom.removeEventListener('pointerleave', onPointerLeave);
      dom.removeEventListener('pointerdown', onPointerDown);
      dom.removeEventListener('pointerup', onPointerUp);
      for (const d of disposables) d();
      stars.geometry.dispose();
      starMat.dispose();
      renderer.dispose();
      if (dom.parentElement === container) container.removeChild(dom);
      sceneRef.current = null;
      hoverIdRef.current = null;
      selectedIdRef.current = null;
    };
    // 仅在结构变化时重建（位置变化不触发）
  }, [buildKey, getNodeColor, onNodeClick, onNodeHover, onBackgroundClick]);

  // 切换自动旋转（由顶栏按钮或内部控制条触发）
  const toggleAutoRotate = () => {
    const ctx = sceneRef.current;
    if (!ctx) return;
    const next = !ctx.controls.autoRotate;
    ctx.controls.autoRotate = next;
    setAutoRotate(next);
  };

  const resetView = () => {
    const ctx = sceneRef.current;
    if (!ctx) return;
    ctx.controls.target.set(0, 0, 0);
    ctx.camera.position.set(0, 140, 620);
    ctx.controls.update();
  };

  return (
    <div ref={containerRef} className="relative w-full h-full bg-background" data-graph3d>
      {webglFailed && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="text-center max-w-xs px-4">
            <p className="text-sm text-muted-foreground mb-2">当前环境不支持 WebGL 3D 渲染</p>
            <p className="text-xs text-muted-foreground/70">请切换到 2D 模式查看图谱</p>
          </div>
        </div>
      )}
      {!webglFailed && viewReady && (
        <>
          {/* 右上角提示 */}
          <div className="absolute top-3 left-3 pointer-events-none select-none">
            <span className="text-[10px] text-muted-foreground/70 bg-background/60 backdrop-blur px-2 py-1 rounded-lg border border-border/50">
              拖拽旋转 · 滚轮缩放 · 点击节点查看详情
            </span>
          </div>
          {/* 右下角控制条 */}
          <div className="absolute bottom-3 right-3 flex gap-1.5">
            <button
              onClick={toggleAutoRotate}
              className={`px-2.5 py-1 text-[10px] rounded-lg border transition-colors ${
                autoRotate
                  ? 'bg-primary text-white border-primary'
                  : 'bg-card text-muted-foreground border-border hover:bg-accent'
              }`}
              aria-label={autoRotate ? '停止自动旋转' : '开启自动旋转'}
            >
              {autoRotate ? '旋转中' : '自动旋转'}
            </button>
            <button
              onClick={resetView}
              className="px-2.5 py-1 text-[10px] rounded-lg border border-border bg-card text-muted-foreground hover:bg-accent transition-colors"
              aria-label="重置视角"
            >
              重置视角
            </button>
          </div>
        </>
      )}
    </div>
  );
}
