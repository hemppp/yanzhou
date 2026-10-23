// ============================================================
// NovelMuse - 安全服务（提示词注入检测）
// ============================================================

/**
 * 危险模式正则表达式
 * 用于检测可能的提示词注入攻击
 */
const DANGEROUS_PATTERNS: RegExp[] = [
  // 脚本标签
  /<script/i,
  /<\/script/i,
  // JavaScript 协议
  /javascript:/i,
  // 事件处理器
  /on\w+\s*=/i,
  /on\w+\s*:/i,
  // 模板字符串注入
  /\$\{[^}]+\}/,
  // 双大括号注入（模板注入）
  /\{\{[^}]+\}\}/,
  // HTML 实体编码（绕过检测）
  /&lt;script|&gt;/i,
  // 字符串拼接（常见 负载）
  /['"`]\s*\+\s*['"`]/,
  // URL 编码的恶意内容
  /%3Cscript|%3E/i,
  // 空白字符填充（绕过）：拦截 C0 控制字符，但保留合法的 \t \n \v \f \r（0x09-0x0D），
  // 否则任何多行输入（如程序化拼装的拆书/续写提示词）都会被误判
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/,
];

/**
 * 需要过滤的危险关键词
 * 涵盖常见 AI prompt injection 攻击模式
 */
const DANGEROUS_KEYWORDS = [
  // 指令忽略/覆盖类
  'ignore previous instructions',
  'ignore all previous',
  'disregard all previous',
  'disregard previous instructions',
  'forget previous instructions',
  'forget all instructions',
  'override system',
  'override instructions',
  'overwrite instructions',
  'overwrite system',
  'system prompt',
  'system message',

  // 角色/身份伪装类
  'you are now',
  'act as',
  'pretend',
  'pretend to be',
  'you are a',
  'impersonate',
  'roleplay',
  'from now on you are',

  // DAN/越狱类
  'DAN',
  'do anything now',
  'jailbreak',
  'developer mode',
  'god mode',
  'admin mode',
  'sudo mode',

  // 注入/绕过类
  ' injection',
  'bypass',
  'bypass restrictions',
  'bypass safety',
  'disables safety',
  'disable safety',
  'remove restrictions',
  'remove safeguards',
  'ignore guidelines',
  'ignore rules',
];

/**
 * 安全配置接口
 */
export interface SecurityConfig {
  /** 启用提示词注入检测 */
  enabled: boolean;
  /** 最大内容长度 */
  maxContentLength: number;
  /** 允许的外部调用次数 */
  maxExternalCalls: number;
}

/**
 * 安全检测结果
 */
export interface SecurityCheckResult {
  /** 是否通过 */
  passed: boolean;
  /** 发现的危险模式 */
  threats: string[];
  /** 建议处理方式 */
  action: 'allow' | 'sanitize' | 'block';
}

/**
 * 默认安全配置
 */
export const DEFAULT_SECURITY_CONFIG: SecurityConfig = {
  enabled: true,
  maxContentLength: 50000, // 50KB
  maxExternalCalls: 10,
};

/**
 * 检测内容中的危险模式
 * @param 内容 待检测的内容
 * @返回 危险模式列表
 */
export function detectDangerousPatterns(content: string): string[] {
  const threats: string[] = [];

  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(content)) {
      threats.push(`危险模式匹配: ${pattern.source}`);
    }
  }

  const lowerContent = content.toLowerCase();
  for (const keyword of DANGEROUS_KEYWORDS) {
    if (lowerContent.includes(keyword.toLowerCase())) {
      threats.push(`危险关键词: ${keyword}`);
    }
  }

  return threats;
}

/**
 * 清理危险内容
 * @param 内容 待清理的内容
 * @返回 清理后的内容
 */
export function sanitizeContent(content: string): string {
  let sanitized = content;

  // 移除脚本标签
  sanitized = sanitized.replace(/<script[^>]*>.*?<\/script>/gis, '[已过滤]');
  sanitized = sanitized.replace(/<script[^>]*>/gi, '[已过滤]');

  // 移除事件处理器
  sanitized = sanitized.replace(/\bon\w+\s*=\s*["'][^"']*["']/gi, '');
  sanitized = sanitized.replace(/\bon\w+\s*:\s*[^;]+;/gi, '');

  // 移除 javascript: 协议
  sanitized = sanitized.replace(/javascript:\s*/gi, '');

  // 移除模板字符串注入
  sanitized = sanitized.replace(/\$\{[^}]+\}/g, '[已过滤]');

  // 移除双大括号注入
  sanitized = sanitized.replace(/\{\{[^}]+\}\}/g, '[已过滤]');

  return sanitized.trim();
}

/**
 * 对用户输入和 AI 返回内容都执行安全检测
 * @param 内容 待检测的内容
 * @param 配置 安全配置
 * @返回 检测结果
 */
export function performSecurityCheck(
  content: string,
  config: SecurityConfig = DEFAULT_SECURITY_CONFIG
): SecurityCheckResult {
  // 如果安全检测被禁用，直接通过
  if (!config.enabled) {
    return {
      passed: true,
      threats: [],
      action: 'allow',
    };
  }

  // 长度检查
  if (content.length > config.maxContentLength) {
    return {
      passed: false,
      threats: [`内容超过最大长度限制 (${config.maxContentLength})`],
      action: 'block',
    };
  }

  // 危险模式检测
  const threats = detectDangerousPatterns(content);

  if (threats.length > 0) {
    return {
      passed: false,
      threats,
      action: 'block',
    };
  }

  return {
    passed: true,
    threats: [],
    action: 'allow',
  };
}

/**
 * 验证用户输入是否安全
 * 用于搜索关键词、用户文本等
 * @param 输入 用户输入
 * @返回 是否安全
 */
export function validateUserInput(input: string): { safe: boolean; sanitized: string } {
  // 先清理
  const sanitized = sanitizeContent(input);

  // 检测清理后是否还有危险
  const result = performSecurityCheck(sanitized);

  return {
    safe: result.passed,
    sanitized: result.passed ? sanitized : '',
  };
}

/**
 * 过滤搜索结果内容
 * 用于 AI 搜索返回的内容二次检测
 * 确保过滤掉可能包含注入内容的搜索结果
 * @param 内容 搜索返回的内容
 * @返回 过滤后的内容
 */
export function filterSearchContent(content: string): string {
  // 先执行安全检测，如果包含危险内容则返回空字符串
  const checkResult = performSecurityCheck(content);
  if (!checkResult.passed) {
    console.warn('[Security] 搜索结果过滤: 检测到危险内容', checkResult.threats);
    return '';
  }
  // 安全检测通过后再进行内容清理
  return sanitizeContent(content);
}

export default {
  detectDangerousPatterns,
  sanitizeContent,
  performSecurityCheck,
  validateUserInput,
  filterSearchContent,
  DEFAULT_SECURITY_CONFIG,
};