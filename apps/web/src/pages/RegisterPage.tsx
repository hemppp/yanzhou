import { useState, useMemo, useRef, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Eye, EyeOff, Check, X, Loader2 } from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';
import { authApi } from '@/services/api/authApi';
import { gsap, useGSAP } from '@/utils/gsap';

type PasswordStrength = 'empty' | 'weak' | 'medium' | 'strong';

function getPasswordStrength(password: string): PasswordStrength {
  if (!password) return 'empty';
  let score = 0;
  if (password.length >= 6) score++;
  if (password.length >= 10) score++;
  if (/[A-Z]/.test(password)) score++;
  if (/[0-9]/.test(password)) score++;
  if (/[^A-Za-z0-9]/.test(password)) score++;
  if (score <= 1) return 'weak';
  if (score <= 3) return 'medium';
  return 'strong';
}

const strengthLabels: Record<PasswordStrength, string> = {
  empty: '',
  weak: '弱',
  medium: '中',
  strong: '强',
};

export function RegisterPage() {
  const navigate = useNavigate();
  const { register, isLoading } = useAuthStore();
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');

  // 用户名实时检测状态：'idle' | 'checking' | 'available' | 'taken' | 'invalid'
  const [usernameStatus, setUsernameStatus] = useState<'idle' | 'checking' | 'available' | 'taken' | 'invalid'>('idle');
  const usernameAbortRef = useRef<AbortController | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  useGSAP(() => {
    gsap.fromTo(containerRef.current,
      { opacity: 0, y: 20 },
      { opacity: 1, y: 0, duration: 0.5, ease: 'power2.out', clearProps: 'opacity,transform' },
    );
    const logo = containerRef.current?.querySelector('h1');
    if (logo) gsap.fromTo(logo,
      { scale: 0.92, opacity: 0 },
      { scale: 1, opacity: 1, duration: 0.5, ease: 'back.out(1.4)', clearProps: 'opacity,transform' },
    );
    const fields = containerRef.current?.querySelectorAll('input, button, label');
    if (fields?.length) gsap.fromTo(fields,
      { opacity: 0, y: 10 },
      { opacity: 1, y: 0, stagger: 0.05, delay: 0.2, duration: 0.35, ease: 'power2.out', clearProps: 'opacity,transform' },
    );
  }, { scope: containerRef });

  const strength = useMemo(() => getPasswordStrength(password), [password]);

  // ---- 用户名实时检测：500ms 防抖 ----
  useEffect(() => {
    const trimmed = username.trim();
    if (!trimmed) {
      setUsernameStatus('idle');
      return;
    }
    if (trimmed.length < 3) {
      setUsernameStatus('invalid');
      return;
    }
    if (!/^[a-zA-Z0-9_]+$/.test(trimmed)) {
      setUsernameStatus('invalid');
      return;
    }

    setUsernameStatus('checking');

    const timer = setTimeout(async () => {
      // 取消上一次在飞请求
      if (usernameAbortRef.current) {
        usernameAbortRef.current.abort();
      }
      const controller = new AbortController();
      usernameAbortRef.current = controller;

      try {
        const result = await authApi.checkUsername(trimmed);
        if (controller.signal.aborted) return;
        if (result.available) {
          setUsernameStatus('available');
        } else if (result.reason === 'taken') {
          setUsernameStatus('taken');
        } else {
          setUsernameStatus('invalid');
        }
      } catch (e) {
        if (controller.signal.aborted) return;
        // 网络错误时不阻塞注册，默认 idle（让用户提交时再看后端结果）
        console.warn('[Register] 用户名检测失败:', e);
        setUsernameStatus('idle');
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [username]);

  // 用户名状态对应的提示文本和颜色
  const usernameHint = useMemo<{
    text: string;
    color: string;
    icon: React.ReactNode;
  } | null>(() => {
    switch (usernameStatus) {
      case 'checking':
        return {
          text: '检测中...',
          color: 'hsl(var(--ink-light))',
          icon: <Loader2 size={12} className="animate-spin" />,
        };
      case 'available':
        return {
          text: '用户名可用',
          color: 'hsl(var(--mountain-cyan))',
          icon: <Check size={12} />,
        };
      case 'taken':
        return {
          text: '用户名已被占用',
          color: 'hsl(var(--vermilion))',
          icon: <X size={12} />,
        };
      case 'invalid':
        return {
          text: '用户名至少 3 个字符，只能包含字母、数字和下划线',
          color: 'hsl(var(--vermilion))',
          icon: <X size={12} />,
        };
      default:
        return null;
    }
  }, [usernameStatus]);

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!username.trim()) {
      setError('请输入用户名');
      return;
    }
    if (username.length < 3) {
      setError('用户名至少 3 个字符');
      return;
    }
    // 提交时如果用户名已确认被占用，直接拦截
    if (usernameStatus === 'taken') {
      setError('用户名已被占用，请换一个');
      return;
    }
    if (usernameStatus === 'invalid') {
      setError('用户名格式不正确');
      return;
    }
    if (!displayName.trim()) {
      setError('请输入显示名称');
      return;
    }
    if (password.length < 8) {
      setError('密码至少 8 个字符');
      return;
    }
    if (!/[a-z]/.test(password)) {
      setError('密码必须包含小写字母');
      return;
    }
    if (!/[A-Z]/.test(password)) {
      setError('密码必须包含大写字母');
      return;
    }
    if (!/\d/.test(password)) {
      setError('密码必须包含数字');
      return;
    }
    if (password !== confirmPassword) {
      setError('两次输入的密码不一致');
      return;
    }
    try {
      await register(username.trim(), password, displayName.trim());
      navigate('/bookshelf', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : '注册失败，请重试');
    }
  };

  // 强度色映射到 token
  const strengthTokenColors: Record<PasswordStrength, string> = {
    empty: 'hsl(var(--border) / 0.4)',
    weak: 'hsl(var(--vermilion))',
    medium: 'hsl(var(--ochre))',
    strong: 'hsl(var(--mountain-cyan))',
  };

  return (
    <div
      ref={containerRef}
      className="min-h-screen flex items-center justify-center px-4 py-8"
    >
      <div className="w-full max-w-[400px]">
        {/* Header — Logo 印章 + Hero 标题 + 引言 */}
        <div className="flex flex-col items-center mb-8">
          <div
            className="nm-logo-seal mb-5 cursor-pointer"
            onClick={() => navigate('/')}
            role="button"
            tabIndex={0}
            title="返回首页"
          >
            墨
          </div>
          <h1
            className="nm-hero-title mb-2 select-none cursor-pointer"
            onClick={() => navigate('/')}
          >
            砚舟
          </h1>
          <p className="nm-hero-quote">以笔为舟 · 思绪如雨</p>
        </div>

        {/* Card — 强化玻璃 + 斜向反光 */}
        <div className="nm-auth-card glass-edge-glow p-8">
          <form onSubmit={handleRegister}>
            {/* Card 标题 */}
            <div className="text-center mb-6">
              <h2
                className="font-serif text-[18.5px] font-semibold mb-1"
                style={{ color: 'hsl(var(--ink))', letterSpacing: '0.02em' }}
              >
                创建账户
              </h2>
              <p className="text-[11px]" style={{ color: 'hsl(var(--ink-light) / 0.7)' }}>
                开启你的写作旅程
              </p>
            </div>

            {/* Error */}
            {error && (
              <div
                className="text-[12px] font-medium mb-5 px-3 py-2.5 rounded-xl"
                style={{
                  color: 'hsl(var(--vermilion))',
                  background: 'hsl(var(--vermilion) / 0.08)',
                  border: '0.5px solid hsl(var(--vermilion) / 0.2)',
                }}
              >
                {error}
              </div>
            )}

            {/* Username */}
            <div className="mb-5">
              <label className="nm-label">用户名</label>
              <input
                type="text"
                className="nm-input"
                placeholder="选择一个用户名"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                style={
                  usernameStatus === 'available'
                    ? { borderColor: 'hsl(var(--mountain-cyan) / 0.5)' }
                    : usernameStatus === 'taken' || usernameStatus === 'invalid'
                      ? { borderColor: 'hsl(var(--vermilion) / 0.5)' }
                      : undefined
                }
              />
              {usernameHint && (
                <div
                  className="flex items-center gap-1 mt-1.5 text-[10px]"
                  style={{ color: usernameHint.color }}
                >
                  {usernameHint.icon}
                  <span>{usernameHint.text}</span>
                </div>
              )}
            </div>

            {/* Display Name */}
            <div className="mb-5">
              <label className="nm-label">显示名称</label>
              <input
                type="text"
                className="nm-input"
                placeholder="他人看到的名字"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                autoComplete="name"
              />
            </div>

            {/* Password */}
            <div className="mb-5">
              <label className="nm-label">密码</label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  className="nm-input"
                  placeholder="设置密码"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 p-1.5 rounded-lg transition-all hover:bg-[rgb(var(--glass-tint)/0.5)]"
                  style={{ color: 'hsl(var(--ink-light) / 0.6)' }}
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>

              {/* Strength bar */}
              {strength !== 'empty' && (
                <div className="flex items-center gap-2 mt-2">
                  <div className="flex-1 h-1 rounded-full" style={{ background: 'hsl(var(--border) / 0.3)' }}>
                    <div
                      className="h-full rounded-full transition-all duration-300"
                      style={{
                        width: strength === 'weak' ? '33%' : strength === 'medium' ? '66%' : '100%',
                        background: strengthTokenColors[strength],
                      }}
                    />
                  </div>
                  <span className="text-[10px] font-medium" style={{ color: strengthTokenColors[strength] }}>
                    {strengthLabels[strength]}
                  </span>
                </div>
              )}
            </div>

            {/* Confirm Password */}
            <div className="mb-6">
              <label className="nm-label">确认密码</label>
              <input
                type={showPassword ? 'text' : 'password'}
                className="nm-input"
                placeholder="再次输入密码"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                autoComplete="new-password"
              />
            </div>

            {/* Buttons */}
            <div className="flex flex-col gap-3">
              <button
                type="submit"
                disabled={isLoading}
                className="nm-btn-primary-pill flex items-center justify-center gap-2 select-none"
              >
                {isLoading ? (
                  <>
                    <span className="inline-block w-3.5 h-3.5 rounded-full border-2 animate-spin" style={{ borderColor: 'rgba(255,255,255,0.3)', borderTopColor: '#ffffff' }} />
                    <span>注册中...</span>
                  </>
                ) : (
                  <span>创建账户</span>
                )}
              </button>
            </div>
          </form>

          {/* 分隔线 */}
          <div className="nm-divider my-6">
            <span className="nm-divider-dot" />
          </div>

          {/* 次要 CTA */}
          <Link to="/login" className="nm-btn-outline-pill select-none">
            已有账户？去登录
          </Link>
        </div>

        {/* 底部 */}
        <div className="flex items-center justify-center gap-4 mt-6 text-[10px]" style={{ color: 'hsl(var(--ink-light) / 0.5)' }}>
          <button
            type="button"
            onClick={() => navigate('/')}
            className="nm-link-quiet"
          >
            返回首页
          </button>
          <span style={{ color: 'hsl(var(--ink-light) / 0.3)' }}>·</span>
          <span>注册即代表你同意我们的服务条款</span>
        </div>
      </div>
    </div>
  );
}
