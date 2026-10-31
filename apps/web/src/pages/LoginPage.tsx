import { useState, useEffect, useRef } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Eye, EyeOff } from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';
import {
  getCredentials,
  saveCredentials,
  clearCredentials,
} from '@/utils/credentials';
import { gsap, useGSAP } from '@/utils/gsap';

export function LoginPage() {
  const navigate = useNavigate();
  const { login, isLoading } = useAuthStore();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [rememberMe, setRememberMe] = useState(true);

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

  useEffect(() => {
    (async () => {
      // 记住我：仅预填用户名（C4 后会话由 HttpOnly Cookie 自动恢复，无需本地密码）
      const credentials = await getCredentials();
      if (credentials) {
        setUsername(credentials.username);
        setRememberMe(credentials.rememberMe);
      }
    })();
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!username.trim()) {
      setError('请输入用户名');
      return;
    }
    if (!password) {
      setError('请输入密码');
      return;
    }
    try {
      await login(username.trim(), password);

      // 记住我：仅记忆用户名（密码不落 localStorage，会话由 HttpOnly Cookie 承载）
      if (rememberMe) {
        await saveCredentials(username.trim());
      } else {
        clearCredentials();
      }

      navigate('/bookshelf', { replace: true });
    } catch (err) {
      // 后端出于安全考虑统一返回"用户名或密码错误"，
      // 前端在登录失败后调用 check-username 区分两种情况，给用户更友好的提示
      const message = err instanceof Error ? err.message : '登录失败，请重试';
      try {
        const { authApi } = await import('@/services/api/authApi');
        const result = await authApi.checkUsername(username.trim());
        if (!result.available && result.reason === 'taken') {
          // 用户名存在但登录失败 → 密码错误
          setError('密码错误，请检查后重试。如忘记密码，请联系管理员重置。');
        } else {
          // 用户名不存在
          setError(`用户名「${username.trim()}」尚未注册，请先去注册页面创建账号。`);
        }
      } catch {
        // check-username 也失败时回退到后端原始错误
        setError(message);
      }
    }
  };

  const handleRememberMeChange = (checked: boolean) => {
    setRememberMe(checked);
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

        {/* Card — 强化玻璃 + 渐变边框 + 顶部高光 + 斜向反光 */}
        <div className="nm-auth-card glass-edge-glow p-8">
          <form onSubmit={handleLogin}>
            {/* Card 标题 */}
            <div className="text-center mb-6">
              <h2
                className="font-serif text-[18.5px] font-semibold mb-1"
                style={{ color: 'hsl(var(--foreground))', letterSpacing: '0.02em' }}
              >
                欢迎归来
              </h2>
              <p className="text-[11px]" style={{ color: 'hsl(var(--muted-foreground))' }}>
                登录以继续你的写作旅程
              </p>
            </div>

            {/* Error */}
            {error && (
              <div
                className="text-[12px] font-medium mb-5 px-3 py-2.5 rounded-xl"
                style={{
                  color: 'var(--vscode-semantic-error)',
                  background: 'var(--vscode-semantic-error-background)',
                  border: '1px solid var(--vscode-semantic-error-border)',
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
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="nm-input"
                placeholder="请输入用户名"
                autoComplete="username"
              />
            </div>

            {/* Password */}
            <div className="mb-6">
              <label className="nm-label">密码</label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="nm-input"
                  placeholder="请输入密码"
                  autoComplete="current-password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 p-1.5 rounded-lg transition-all hover:bg-[rgb(var(--glass-tint)/0.5)]"
                  style={{ color: 'hsl(var(--muted-foreground))' }}
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>

            {/* Options */}
            <div className="flex items-center justify-between mb-6">
              <label
                className="flex items-center gap-2 cursor-pointer select-none text-[12px]"
                style={{ color: 'hsl(var(--muted-foreground))' }}
              >
                <span
                  className="relative inline-flex items-center justify-center w-4 h-4 rounded"
                  style={{
                    border: '0.5px solid hsl(var(--border))',
                    background: rememberMe ? 'hsl(var(--primary))' : 'transparent',
                    transition: 'all 0.2s ease',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={rememberMe}
                    onChange={(e) => handleRememberMeChange(e.target.checked)}
                    className="absolute opacity-0 w-full h-full m-0 p-0"
                    style={{ margin: 0, cursor: 'pointer' }}
                  />
                  {rememberMe && (
                    <svg width="10" height="8" viewBox="0 0 10 8" fill="none" style={{ position: 'absolute', pointerEvents: 'none' }}>
                      <path d="M1 4L3.5 6.5L9 1" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </span>
                <span>记住我</span>
              </label>
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
                    <span>登录中...</span>
                  </>
                ) : (
                  <span>登录</span>
                )}
              </button>
            </div>
          </form>

          {/* 分隔线 */}
          <div className="nm-divider my-6">
            <span className="nm-divider-dot" />
          </div>

          {/* 次要 CTA */}
          <Link to="/register" className="nm-btn-outline-pill select-none">
            创建新账户
          </Link>
        </div>

        {/* 底部 */}
        <div className="flex items-center justify-center gap-4 mt-6 text-[10px]" style={{ color: 'hsl(var(--muted-foreground))' }}>
          <Link to="/register" className="nm-link-quiet">
            忘记密码？
          </Link>
          <span style={{ color: 'hsl(var(--border))' }}>·</span>
          <button
            type="button"
            onClick={() => navigate('/')}
            className="nm-link-quiet"
          >
            返回首页
          </button>
        </div>
      </div>
    </div>
  );
}
