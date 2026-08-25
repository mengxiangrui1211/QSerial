/**
 * 配置类型定义
 */

/**
 * 应用配置
 */
export interface AppConfig {
  app: AppSettings;
  terminal: TerminalSettings;
  serial: SerialSettings;
  ssh: SshSettings;
  serialShare: SerialShareSettings; // @deprecated 使用 connectionShare
  connectionShare: ConnectionShareSettings;
  mcp: McpSettings;
  window: WindowSettings;
}

/**
 * 应用设置
 */
export interface AppSettings {
  language: 'zh-CN' | 'en-US';
  theme: string;
  uiFontFamily: string;
  autoUpdate: boolean;
  checkUpdateOnStartup: boolean;
  minimizeToTray: boolean;
  closeToTray: boolean;
}

/**
 * 终端设置
 */
export interface TerminalSettings {
  fontSize: number;
  fontFamily: string;
  scrollback: number;
  copyOnSelect: boolean;
  rightClickPaste: boolean;
  bellStyle: 'none' | 'sound' | 'visual';
  enableWebLinks: boolean;
  autoReconnect: boolean;
  reconnectInterval: number;
  reconnectAttempts: number;
  /**
   * 显示模式：
   * - 'terminal' 终端仿真（VT100，适合 SSH/交互式 AT/带 ANSI 颜色）
   * - 'monitor'  串口监控视图（pre-wrap 文本，连续显示、随窗口重排，适合帧协议调试）
   */
  displayMode: 'terminal' | 'monitor';
  /**
   * 换行符归一化（仅终端模式生效）：把裸 LF/CR 归一为 CRLF，消除阶梯错位。UTF-8 安全。
   */
  normalizeLineEndings: boolean;
  /** 监控视图：每行显示时间戳 */
  monitorTimestamp: boolean;
  /** 监控视图：过滤 ANSI 转义序列（避免彩色日志变成乱码符号） */
  monitorAnsiFilter: boolean;
  /** 监控视图：按接收间隔自动插入换行分帧（解决粘包） */
  monitorTimeoutFraming: boolean;
  /** 监控视图：分帧间隔阈值（毫秒），超过该间隔则视为新的一帧 */
  monitorTimeoutMs: number;
}

/**
 * 串口设置
 */
export interface SerialSettings {
  defaultBaudRate: number;
  defaultDataBits: 5 | 6 | 7 | 8;
  defaultStopBits: 1 | 1.5 | 2;
  defaultParity: 'none' | 'even' | 'odd';
  autoReconnect: boolean;
  reconnectInterval: number;
  reconnectAttempts: number;
  showTimestamp: boolean;
  hexDisplay: boolean;
}

/**
 * SSH 设置
 */
export interface SshSettings {
  keepaliveInterval: number;
  keepaliveCountMax: number;
  readyTimeout: number;
  defaultPort: number;
}

/**
 * 串口共享设置
 * @deprecated 使用 ConnectionShareSettings 替代
 */
export interface SerialShareSettings {
  defaultLocalPort: number;
}

/**
 * 连接共享设置
 */
export interface ConnectionShareSettings {
  defaultLocalPort: number;
  defaultListenAddress?: string;
}

export interface McpSettings {
  enabled: boolean;
  port: number;
  listenAddress: string;
  authPassword: string;
  corsOrigins: string[];
}

/**
 * 窗口设置
 */
export interface WindowSettings {
  width: number;
  height: number;
  x?: number;
  y?: number;
  maximized: boolean;
}

/**
 * 默认配置
 */
export const DEFAULT_CONFIG: AppConfig = {
  app: {
    language: 'zh-CN',
    theme: 'dracula',
    uiFontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    autoUpdate: true,
    checkUpdateOnStartup: false,
    minimizeToTray: false,
    closeToTray: false,
  },

  terminal: {
    fontSize: 14,
    fontFamily: 'JetBrains Mono, Consolas, "Courier New", monospace',
    scrollback: 10000,
    copyOnSelect: false,
    rightClickPaste: true,
    bellStyle: 'none',
    enableWebLinks: true,
    autoReconnect: true,
    reconnectInterval: 3000,
    reconnectAttempts: 5,
    displayMode: 'terminal',
    normalizeLineEndings: true,
    monitorTimestamp: false,
    monitorAnsiFilter: true,
    monitorTimeoutFraming: false,
    monitorTimeoutMs: 100,
  },

  serial: {
    defaultBaudRate: 9600,
    defaultDataBits: 8,
    defaultStopBits: 1,
    defaultParity: 'none',
    autoReconnect: true,
    reconnectInterval: 3000,
    reconnectAttempts: 5,
    showTimestamp: false,
    hexDisplay: false,
  },

  ssh: {
    keepaliveInterval: 30000,
    keepaliveCountMax: 3,
    readyTimeout: 20000,
    defaultPort: 22,
  },

  serialShare: {
    defaultLocalPort: 8888,
  },

  connectionShare: {
    defaultLocalPort: 8888,
    defaultListenAddress: '0.0.0.0',
  },

  mcp: {
    enabled: false,
    port: 9800,
    listenAddress: '127.0.0.1',
    authPassword: '',
    corsOrigins: [],
  },
  window: {
    width: 1200,
    height: 800,
    maximized: false,
  },
};
