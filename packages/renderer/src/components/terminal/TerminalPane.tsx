/**
 * 终端面板组件
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Terminal as XTerm } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { SearchAddon } from 'xterm-addon-search';
import { useTerminalStore } from '@/stores/terminal';
import { useThemeStore } from '@/stores/theme';
import { useTerminalMacroStore, PRESET_MACRO_COLORS } from '@/stores/terminalMacro';
import { useQuickButtonsStore } from '@/stores/quickButtons';
import { useConfigStore } from '@/stores/config';
import { base64ToUint8Array, ConnectionType, ConnectionState } from '@qserial/shared';
import 'xterm/css/xterm.css';

import { ConnectionShareDialog } from '../dialogs/ConnectionShareDialog';
import { globalError } from '../common/ErrorToast';
import { AtTransactionPanel, type AtTransaction } from './AtTransactionPanel';

// xterm.js 5.x 内部 API 类型（非公共 API，用于兼容性 patch）
interface XTermCore {
  viewport?: {
    syncScrollArea: (...args: unknown[]) => unknown;
    _refresh?: (e: boolean) => unknown;
    _innerRefresh?: (...args: unknown[]) => unknown;
  };
  _renderService?: {
    dimensions?: unknown;
  };
}

interface TerminalPaneProps {
  sessionId: string;
  connectionId: string;
  isActive: boolean;
  activeTabId?: string | null;
}

export const TerminalPane: React.FC<TerminalPaneProps> = React.memo(
  ({ sessionId, connectionId, isActive, activeTabId }) => {
    const { t } = useTranslation();
    const containerRef = useRef<HTMLDivElement>(null);
    const xtermRef = useRef<XTerm | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const searchAddonRef = useRef<SearchAddon | null>(null);
    const unsubscribersRef = useRef<(() => void)[]>([]);
    const messageShownRef = useRef(false);
    const wasDisconnectedRef = useRef(false);
    const isComposingRef = useRef(false);
    const compositionDataRef = useRef<string>('');
    const [logStarting, setLogStarting] = useState(false);
    const [reconnectLoading, setReconnectLoading] = useState(false);
    const [isRecording, setIsRecording] = useState(false);
    const [showMacroSave, setShowMacroSave] = useState(false);
    const [macroName, setMacroName] = useState('');
    const [macroDesc, setMacroDesc] = useState('');
    const [macroColor, setMacroColor] = useState('');
    const initializedRef = useRef(false);
    const disposedRef = useRef(false);
    const [searchVisible, setSearchVisible] = useState(false);
    const [searchText, setSearchText] = useState('');
    const [searchCaseSensitive, setSearchCaseSensitive] = useState(false);
    const [filterEnabled, setFilterEnabled] = useState(false);
    const [filterText, setFilterText] = useState('');
    const searchInputRef = useRef<HTMLInputElement>(null);
    const filterInputRef = useRef<HTMLInputElement>(null);
    const searchDebounceRef = useRef<ReturnType<typeof setTimeout>>();
    const searchPosRef = useRef(-1);
    const [showSerialShareDialog, setShowSerialShareDialog] = useState(false);
    // P0: 暂停滚动状态（用于触发重渲染）
    const [pauseScrollState, setPauseScrollState] = useState(false);
    // P0: 常驻命令输入框
    const [cmdInputValue, setCmdInputValue] = useState('');
    const [cmdMode, setCmdMode] = useState<'text' | 'hex'>('text');
    const cmdInputRef = useRef<HTMLInputElement>(null);

    // P1: AT 事务追踪
    const [atTransactions, setAtTransactions] = useState<AtTransaction[]>([]);
    const pendingAtRef = useRef<{ command: string; timestamp: number } | null>(null);
    const atResponseBufferRef = useRef<string>('');
    const timeoutIdsRef = useRef<ReturnType<typeof setTimeout>[]>([]);
    const mountCountRef = useRef(0);

    // P0: 时间戳 + 收发分色 + 暂停滚动
    const atNewLineRef = useRef(true);        // 是否在新行开头（用于注入时间戳）
    const pauseScrollRef = useRef(false);      // 是否暂停自动滚动
    const timestampEnabledRef = useRef(true);  // 时间戳开关

    // 格式化时间戳 [HH:MM:SS.mmm]
    const formatTimestamp = useCallback((): string => {
      const now = new Date();
      const h = String(now.getHours()).padStart(2, '0');
      const m = String(now.getMinutes()).padStart(2, '0');
      const s = String(now.getSeconds()).padStart(2, '0');
      const ms = String(now.getMilliseconds()).padStart(3, '0');
      return `${h}:${m}:${s}.${ms}`;
    }, []);

    // 带时间戳 + 方向色的写入
    // direction: 'rx' (接收,默认色) | 'tx' (发送,蓝色) | 'noise' (噪声,暗色)
    const writeWithTimestamp = useCallback(
      (terminal: XTerm, data: Uint8Array | string, direction: 'rx' | 'tx' | 'noise' = 'rx') => {
        if (!timestampEnabledRef.current) {
          // 不启用时间戳时直接写入，仅做方向着色
          if (direction === 'tx') {
            terminal.write(`\x1b[38;5;69m${typeof data === 'string' ? data : new TextDecoder().decode(data)}\x1b[0m`);
          } else if (direction === 'noise') {
            terminal.write(`\x1b[38;5;240m${typeof data === 'string' ? data : new TextDecoder().decode(data)}\x1b[0m`);
          } else {
            terminal.write(data);
          }
          return;
        }

        const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
        // 按换行符拆分，每段在新行开头注入时间戳
        const parts = text.split(/(\r\n|\n|\r)/);
        const ts = formatTimestamp();

        // ANSI 颜色码
        const colorTx = '\x1b[38;5;69m';   // 柔蓝
        const colorNoise = '\x1b[38;5;240m'; // 暗灰
        const colorTs = '\x1b[38;5;240m';    // 时间戳暗灰
        const colorReset = '\x1b[0m';
        const colorDir = direction === 'tx' ? colorTx : direction === 'noise' ? colorNoise : '';

        for (let i = 0; i < parts.length; i++) {
          const part = parts[i];
          if (part === '') continue;

          // 如果是换行符
          if (/^\r\n$|^\n$|^\r$/.test(part)) {
            terminal.write(part);
            atNewLineRef.current = true;
            continue;
          }

          // 在新行开头注入时间戳
          if (atNewLineRef.current) {
            const dirLabel = direction === 'tx' ? 'TX' : 'RX';
            terminal.write(`${colorTs}[${ts}] ${dirLabel}${colorReset} `);
            atNewLineRef.current = false;
          }

          // 写入数据（带方向色 + 关键字高亮）
          if (colorDir) {
            // 噪声数据直接暗色写入
            terminal.write(`${colorDir}${part}${colorReset}`);
          } else {
            // RX 正常数据：检测并高亮关键字 OK/ERROR/WARN/+XXX
            const highlighted = part
              .replace(/\b(OK)\b/g, '\x1b[38;5;72m$1\x1b[0m')
              .replace(/\b(ERROR|FAIL|FAILED)\b/g, '\x1b[38;5;203m$1\x1b[0m')
              .replace(/\b(WARN|WARNING)\b/g, '\x1b[38;5;179m$1\x1b[0m')
              .replace(/(\+[A-Z]+:)/g, '\x1b[38;5;141m$1\x1b[0m');
            terminal.write(highlighted);
          }
        }

        // 如果数据以换行结尾，标记下次在新行注入时间戳
        if (/\r\n$|\n$|\r$/.test(text)) {
          atNewLineRef.current = true;
        }
      },
      [formatTimestamp]
    );

    // 使用 selector 精准订阅，避免其他 session 变更导致本组件重渲染
    const session = useTerminalStore((state) => state.sessions[sessionId]);
    const updateSessionSize = useTerminalStore((state) => state.updateSessionSize);
    const updateSessionState = useTerminalStore((state) => state.updateSessionState);
    const startLog = useTerminalStore((state) => state.startLog);
    const stopLog = useTerminalStore((state) => state.stopLog);
    const { currentTheme } = useThemeStore();
    const { config } = useConfigStore();

    // 调整终端尺寸 - 使用 FitAddon
    const resizeTerminal = useCallback(() => {
      if (!xtermRef.current || !fitAddonRef.current || !containerRef.current) return;

      try {
        fitAddonRef.current.fit();
        const { cols, rows } = xtermRef.current;
        window.qserial.connection.resize(connectionId, cols, rows).catch(() => {});
        updateSessionSize(sessionId, cols, rows);
      } catch {
        // 忽略 resize 错误
      }
    }, [connectionId, sessionId, updateSessionSize]);

    // 初始化终端（只执行一次，组件卸载时才销毁）
    useEffect(() => {
      // 防止重复初始化
      if (initializedRef.current) return;
      if (!containerRef.current) return;

      initializedRef.current = true;
      disposedRef.current = false;
      mountCountRef.current += 1;
      const mountId = mountCountRef.current;
      const openedRef = { current: false }; // 追踪 xterm.open() 是否已调用
      console.log(
        '[TerminalPane] INIT xterm mountId:',
        mountId,
        'sessionId:',
        sessionId.slice(0, 8),
        'connectionId:',
        connectionId.slice(0, 8)
      );

      const xterm = new XTerm({
        theme: currentTheme.xterm,
        fontFamily: config.terminal.fontFamily,
        fontSize: config.terminal.fontSize,
        cursorBlink: true,
        scrollback: config.terminal.scrollback,
        allowProposedApi: true,
      });

      const fitAddon = new FitAddon();
      // 不在 open 前 loadAddon：xterm-addon-fit 会 wrap open() 在内
      // 部异步 Viewport 初始化完成前调用 fit()，导致 _renderService 未定义

      xtermRef.current = xterm;
      fitAddonRef.current = fitAddon;

      // 显示连接成功消息的函数
      const showConnectionSuccessMessage = (terminal: XTerm) => {
        if (messageShownRef.current) return;
        messageShownRef.current = true;

        const now = new Date();
        const time = now.toLocaleTimeString();
        const date = now.toLocaleDateString();

        const getDisplayWidth = (str: string) => {
          let width = 0;
          for (const char of str) {
            if (/[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/.test(char)) {
              width += 2;
            } else {
              width += 1;
            }
          }
          return width;
        };

        const makeLine = (content: string) => {
          // eslint-disable-next-line no-control-regex
          const visibleLen = getDisplayWidth(content.replace(/\x1b\[[0-9;]*m/g, ''));
          const padding = ' '.repeat(39 - visibleLen);
          return `  \x1b[1;36m|\x1b[0m ${content}${padding}\x1b[1;36m|\x1b[0m`;
        };

        terminal.write('\r\n');
        terminal.write('  \x1b[1;36m╔════════════════════════════════════════╗\x1b[0m\r\n');
        terminal.write(makeLine('') + '\r\n');
        terminal.write(
          makeLine(`  \x1b[1;32m★ ${t('terminalPane.serialConnectSuccess')} ★\x1b[0m`) + '\r\n'
        );
        terminal.write(makeLine('') + '\r\n');
        terminal.write(makeLine(`  \x1b[33m●\x1b[0m ${t('terminalPane.date')}: ` + date) + '\r\n');
        terminal.write(makeLine(`  \x1b[33m●\x1b[0m ${t('terminalPane.time')}: ` + time) + '\r\n');
        terminal.write(makeLine('') + '\r\n');
        terminal.write('  \x1b[1;36m╚════════════════════════════════════════╝\x1b[0m\r\n');
        terminal.write('\r\n');
      };

      // 等待容器有实际尺寸后再 open xterm
      const openXterm = () => {
        // mountId 守卫：只处理当前 mount 的调用，防止旧 mount 残留的 setTimeout/ResizeObserver
        if (mountCountRef.current !== mountId) return;
        if (disposedRef.current || !xtermRef.current || !containerRef.current) return;

        const container = containerRef.current;
        if (container.clientWidth === 0 || container.clientHeight === 0) {
          // 容器尺寸还没就绪，使用 ResizeObserver 继续等待
          const ro = new ResizeObserver(() => {
            if (mountCountRef.current !== mountId) {
              ro.disconnect();
              return;
            }
            if (container.clientWidth > 0 && container.clientHeight > 0) {
              ro.disconnect();
              openXterm();
            }
          });
          ro.observe(container);
          unsubscribersRef.current.push(() => ro.disconnect());
          return;
        }

        try {
          xterm.open(container);
          // 安全化 Viewport 的异步回调：xterm 内部 Viewport 构造函数会
          // setTimeout(() => this.syncScrollArea())，且 dispose 时不清除该 timeout；
          // syncScrollArea 内部还会 _refresh → rAF(_innerRefresh) 异步链路。
          // 必须用 mountCountRef 而非 disposedRef（后者会被新 mount 重置为 false）
          try {
            const core = (xterm as unknown as { _core?: XTermCore })._core;
            if (core?.viewport) {
              const capturedMountId = mountId;
              // 方案1：patch RenderService.dimensions getter — 从根源消除异常
              // 当 _renderer.value 为 undefined（Renderer 未就绪或已 dispose）时，
              // 返回 null 而非抛 TypeError。这是最可靠的方案，因为所有
              // Viewport 异步回调最终都会访问这个 getter。
              try {
                const renderService = core._renderService;
                if (renderService) {
                  const desc = Object.getOwnPropertyDescriptor(
                    Object.getPrototypeOf(renderService),
                    'dimensions'
                  );
                  if (desc?.get) {
                    const origGetter = desc.get;
                    Object.defineProperty(renderService, 'dimensions', {
                      get: function () {
                        try {
                          return origGetter.call(this);
                        } catch {
                          return null;
                        }
                      },
                      configurable: true,
                    });
                  }
                }
              } catch {
                /* dimensions patch 失败 */
              }

              // 方案2：同时 patch Viewport 三个关键方法，
              // 提供双重保护 + mountId 守卫防止已 dispose 实例的回调
              const vp = core.viewport;
              const origSync = vp.syncScrollArea.bind(vp);
              const origRefresh = vp._refresh?.bind(vp);
              const origInnerRefresh = vp._innerRefresh?.bind(vp);
              vp.syncScrollArea = function (...args: unknown[]) {
                if (mountCountRef.current !== capturedMountId) return;
                try {
                  return origSync(...args);
                } catch {
                  /* dimensions 未就绪/已 dispose */
                }
              };
              if (origRefresh) {
                vp._refresh = function (e3: boolean) {
                  if (mountCountRef.current !== capturedMountId) return;
                  try {
                    return origRefresh(e3);
                  } catch {
                    /* dimensions 未就绪/已 dispose */
                  }
                };
              }
              if (origInnerRefresh) {
                vp._innerRefresh = function (...args: unknown[]) {
                  if (mountCountRef.current !== capturedMountId) return;
                  try {
                    return origInnerRefresh(...args);
                  } catch {
                    /* dimensions 未就绪/已 dispose */
                  }
                };
              }
            }
          } catch {
            /* patch 失败不影响核心功能 */
          }

          openedRef.current = true;
          // open 之后再加载 FitAddon，避免 addon wrap open() 后 Viewport 异步初始化竞态
          xterm.loadAddon(fitAddon);
          const searchAddon = new SearchAddon();
          searchAddonRef.current = searchAddon;
          xterm.loadAddon(searchAddon);
          // 延迟一帧 fit，确保 Viewport 内部异步初始化(setTimeout→rAF)完成
          requestAnimationFrame(() => {
            if (mountCountRef.current !== mountId) return;
            try {
              fitAddon.fit();
            } catch {
              /* ignore */
            }
          });
        } catch (e) {
          console.error('[TerminalPane] Failed to open terminal:', e);
          return;
        }

        // 确保 textarea 元素正确配置以支持中文输入法
        const textarea = xterm.textarea;
        if (textarea) {
          textarea.setAttribute('autocomplete', 'off');
          textarea.setAttribute('autocorrect', 'off');
          textarea.setAttribute('autocapitalize', 'off');
          textarea.setAttribute('spellcheck', 'false');
          textarea.style.fontFamily = config.terminal.fontFamily;
          textarea.style.fontSize = `${config.terminal.fontSize}px`;

          // 立即绑定 composition 事件（在 xterm.open 之后）
          const handleCompositionStart = () => {
            isComposingRef.current = true;
            compositionDataRef.current = '';
          };
          const handleCompositionEnd = (e: CompositionEvent) => {
            // composition 结束后，记录最终的中文数据
            // 不在这里发送，让 onData 来发送，避免重复
            const finalData = e.data;
            compositionDataRef.current = finalData;
            // 立即重置 isComposing，让 onData 可以发送数据
            isComposingRef.current = false;
          };

          textarea.addEventListener('compositionstart', handleCompositionStart);
          textarea.addEventListener('compositionend', handleCompositionEnd);

          // 添加到清理列表
          unsubscribersRef.current.push(() => {
            textarea.removeEventListener('compositionstart', handleCompositionStart);
            textarea.removeEventListener('compositionend', handleCompositionEnd);
          });
        }

        // 延迟调度（自动追踪，cleanup 时统一清除）
        const schedule = (fn: () => void, ms: number) => {
          const id = setTimeout(fn, ms);
          timeoutIdsRef.current.push(id);
          return id;
        };

        // 多次延迟调整尺寸，确保布局稳定
        const resizeMultiple = () => {
          resizeTerminal();
          schedule(resizeTerminal, 50);
          schedule(resizeTerminal, 100);
          schedule(resizeTerminal, 200);
          schedule(resizeTerminal, 500);
        };

        // 延迟初始化后调整尺寸
        schedule(async () => {
          resizeMultiple();

          // 主动查询当前连接状态（因为可能错过了 connected 事件）
          try {
            const { state } = await window.qserial.connection.getState(connectionId);
            console.log('[TerminalPane] Queried state:', state, 'mountId:', mountId);

            // 更新 session 状态
            updateSessionState(sessionId, state as ConnectionState);

            if (state === 'connected') {
              const session = useTerminalStore.getState().sessions[sessionId];
              console.log(
                '[TerminalPane] Session connectionType:',
                session?.connectionType,
                'mountId:',
                mountId
              );
              if (session?.connectionType === ConnectionType.SERIAL) {
                console.log('[TerminalPane] Showing connection success message! mountId:', mountId);
                showConnectionSuccessMessage(xterm);
              }
            }
          } catch (err) {
            console.error('[TerminalPane] Failed to get state:', err);
          }
        }, 50);
      };

      // 启动
      openXterm();

      // 添加复制粘贴和搜索支持
      xterm.attachCustomKeyEventHandler((event) => {
        if (event.ctrlKey && event.key === 'f') {
          openSearch();
          return false;
        }
        if (event.ctrlKey && event.key === 'c') {
          const selection = xterm.getSelection();
          if (selection) {
            navigator.clipboard.writeText(selection);
            return false;
          }
          return true;
        }
        if (event.ctrlKey && event.key === 'v') {
          // 阻止默认行为，通过 onData 事件处理粘贴
          return false;
        }
        return true;
      });

      // 用户输入（包括粘贴）
      xterm.onData((data) => {
        console.log(
          '[TerminalPane] onData received:',
          JSON.stringify(data),
          'connectionId:',
          connectionId.slice(0, 8)
        );
        // 如果在 composition 过程中，不发送数据
        if (isComposingRef.current) {
          console.log('[TerminalPane] onData blocked by composition');
          return;
        }

        // P0: 发送数据(TX)写入终端显示，用蓝色 + 时间戳标记
        writeWithTimestamp(xterm, data, 'tx');

        // 如果数据与 composition 结束时的数据相同，发送后清空标记
        if (data === compositionDataRef.current) {
          console.log('[TerminalPane] onData sending (composition end)');
          window.qserial.connection.write(connectionId, data);
          console.log('[Macro] Record step:', JSON.stringify(data));
          addStep(data);
          compositionDataRef.current = ''; // 清空标记，防止重复
          return;
        }
        console.log('[TerminalPane] onData sending');
        window.qserial.connection.write(connectionId, data);
        console.log('[Macro] Record step:', JSON.stringify(data));
        addStep(data);
      });

      // 监听后端数据
      const unsubscribeData = window.qserial.connection.onData(
        connectionId,
        (base64Data: string) => {
          // 终端已销毁时不再写入数据，防止触发 xterm 内部异步回调链崩溃
          if (disposedRef.current) return;
          try {
            const data = base64ToUint8Array(base64Data);
            // P0: 检测噪声数据（如 ?MVA(...)! 刷屏模式）
            let direction: 'rx' | 'noise' = 'rx';
            const text = new TextDecoder().decode(data);
            // 噪声特征：以 ? 或不可见控制字符开头，且行内无 AT 响应关键字
            if (/^[?\x00-\x1f].{3,}/.test(text) && !/^(OK|ERROR|\+|REBOOT|#|\$)/.test(text.trim())) {
              direction = 'noise';
            }

            // P0: 带时间戳 + 方向色写入
            writeWithTimestamp(xterm, data, direction);

            // P1: AT 事务响应追踪
            if (pendingAtRef.current && direction !== 'noise') {
              atResponseBufferRef.current += text;
              const buf = atResponseBufferRef.current;
              // 检测 OK / ERROR 完成响应
              if (/\bOK\b/.test(buf) || /\bERROR\b/.test(buf) || /\bFAIL/.test(buf)) {
                const isOk = /\bOK\b/.test(buf);
                const elapsed = Date.now() - pendingAtRef.current.timestamp;
                const responseText = buf.trim();
                setAtTransactions((prev) =>
                  [
                    {
                      id: `at-${pendingAtRef.current!.timestamp}`,
                      command: pendingAtRef.current!.command,
                      response: responseText,
                      status: isOk ? ('ok' as const) : ('error' as const),
                      timestamp: pendingAtRef.current!.timestamp,
                      durationMs: elapsed,
                    },
                    ...prev,
                  ].slice(0, 50)
                );
                pendingAtRef.current = null;
                atResponseBufferRef.current = '';
              }
            }

            // P0: 暂停滚动时不自动滚到底部
            if (!pauseScrollRef.current) {
              xterm.scrollToBottom();
            }

            // 实时写入日志（日志需要文本）
            const currentSession = useTerminalStore.getState().sessions[sessionId];
            if (currentSession?.logEnabled && currentSession?.logFilePath) {
              window.qserial.log.write(sessionId, text).catch((err) => {
                console.error('Failed to write log:', err);
              });
            }
          } catch (error) {
            console.error('Failed to write terminal data:', error);
          }
        }
      );
      unsubscribersRef.current.push(unsubscribeData);

      // 监听连接状态
      const unsubscribeState = window.qserial.connection.onStateChange(
        connectionId,
        (state: string) => {
          if (disposedRef.current) return;
          console.log(
            '[TerminalPane] State changed:',
            state,
            'sessionId:',
            sessionId.slice(0, 8),
            'mountId:',
            mountId
          );
          updateSessionState(sessionId, state as ConnectionState);
          if (state === 'connected') {
            const currentSession = useTerminalStore.getState().sessions[sessionId];
            if (currentSession?.connectionType === ConnectionType.SERIAL) {
              showConnectionSuccessMessage(xterm);
            }
            if (wasDisconnectedRef.current && currentSession) {
              xterm.write(`\r\n\x1b[32m${t('terminalPane.connectionRestored')}\x1b[0m\r\n`);
            }
            wasDisconnectedRef.current = false;
          } else if (state === 'disconnected') {
            wasDisconnectedRef.current = true;
            messageShownRef.current = false;
            const currentSession = useTerminalStore.getState().sessions[sessionId];
            if (currentSession) {
              xterm.write(`\r\n\x1b[33m${t('terminalPane.connectionLost')}\x1b[0m\r\n`);
            }
          } else if (state === 'reconnecting') {
            wasDisconnectedRef.current = true;
            xterm.write(`\r\n\x1b[33m${t('terminalPane.reconnecting')}\x1b[0m\r\n`);
          }
        }
      );
      unsubscribersRef.current.push(unsubscribeState);

      // 监听连接错误
      const unsubscribeError = window.qserial.connection.onError(connectionId, (error: string) => {
        console.error(
          '[TerminalPane] Connection error:',
          error,
          'connectionId:',
          connectionId.slice(0, 8)
        );
        xterm.write(`\x1b[31m${t('terminalPane.error')}: ${error}\x1b[0m\r\n`);
      });
      unsubscribersRef.current.push(unsubscribeError);

      // 窗口大小变化时自适应
      const resizeObserver = new ResizeObserver(() => {
        resizeTerminal();
      });

      if (containerRef.current) {
        resizeObserver.observe(containerRef.current);
      }

      return () => {
        console.log(
          '[TerminalPane] DISPOSE xterm mountId:',
          mountId,
          'sessionId:',
          sessionId.slice(0, 8)
        );
        disposedRef.current = true;
        // 清除所有未完成的 timeout
        timeoutIdsRef.current.forEach(clearTimeout);
        timeoutIdsRef.current = [];
        resizeObserver.disconnect();
        unsubscribersRef.current.forEach((unsub) => unsub());
        unsubscribersRef.current = [];
        // 同步 dispose，避免 rAF 延迟导致 StrictMode 双挂载时新旧实例冲突
        try {
          xterm.dispose();
        } catch {
          /* ignore */
        }
        xtermRef.current = null;
        fitAddonRef.current = null;
        initializedRef.current = false;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [connectionId, sessionId]);

    // 主题和配置变化
    useEffect(() => {
      if (xtermRef.current) {
        xtermRef.current.options.theme = currentTheme.xterm;
        xtermRef.current.options.fontFamily = config.terminal.fontFamily;
        xtermRef.current.options.fontSize = config.terminal.fontSize;
      }
    }, [currentTheme, config.terminal.fontFamily, config.terminal.fontSize]);

    // 激活时聚焦和调整尺寸
    useEffect(() => {
      if (isActive && xtermRef.current) {
        // 延迟调整尺寸，确保容器已显示
        setTimeout(() => {
          if (xtermRef.current && fitAddonRef.current) {
            try {
              fitAddonRef.current.fit();
            } catch {
              // 忽略错误
            }
          }
        }, 50);
        xtermRef.current.focus();
      }
    }, [isActive, activeTabId]);

    // 搜索状态管理 — 使用 ref 避免闭包陈旧问题
    const searchStateRef = useRef({ text: '', filterText: '', caseSensitive: false });

    // 转义正则特殊字符
    const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const bufferSearch = useCallback((forward: boolean) => {
      const term = xtermRef.current;
      if (!term) return;
      const { text, filterText: ft, caseSensitive } = searchStateRef.current;
      if (!text.trim()) return;
      const buffer = term.buffer.active;
      const flags = caseSensitive ? '' : 'i';
      const primaryRe = new RegExp(escapeRegex(text), flags);
      const hasFilter = ft.trim().length > 0;
      const filterRe = hasFilter ? new RegExp(escapeRegex(ft), flags) : null;
      const total = buffer.length;
      const start = searchPosRef.current;

      // 从当前匹配位置的下一行开始，初始为 -1 时从 buffer 首行/末行开始
      const startIdx = forward
        ? start >= 0
          ? (start + 1) % total
          : 0
        : start >= 0
          ? (((start - 1) % total) + total) % total
          : total - 1;

      for (let i = 0; i < total; i++) {
        const idx = forward ? (startIdx + i) % total : (((startIdx - i) % total) + total) % total;
        const line = buffer.getLine(idx);
        if (!line) continue;
        const lineText = line.translateToString();
        if (filterRe && !filterRe.test(lineText)) continue;
        const m = primaryRe.exec(lineText);
        if (m) {
          const col = m.index;
          searchPosRef.current = idx;
          term.select(idx - buffer.baseY, col, text.length);
          term.scrollToLine(idx - buffer.baseY);
          return;
        }
      }
    }, []);

    const findNext = useCallback(() => {
      const state = searchStateRef.current;
      if (state.filterText.trim() || !searchAddonRef.current) {
        bufferSearch(true);
      } else {
        searchAddonRef.current!.findNext(state.text, {
          caseSensitive: state.caseSensitive,
          incremental: false,
        });
      }
    }, [bufferSearch]);

    const findPrevious = useCallback(() => {
      const state = searchStateRef.current;
      if (state.filterText.trim() || !searchAddonRef.current) {
        bufferSearch(false);
      } else {
        searchAddonRef.current!.findPrevious(state.text, {
          caseSensitive: state.caseSensitive,
          incremental: false,
        });
      }
    }, [bufferSearch]);

    const doSearch = useCallback(
      (text: string, filter: string, caseSensitive: boolean) => {
        searchStateRef.current = { text, caseSensitive, filterText: filter };
        searchPosRef.current = -1;
        if (!text.trim()) return;
        if (filter.trim()) {
          bufferSearch(true);
        } else {
          try {
            searchAddonRef.current?.findNext(text, { caseSensitive, incremental: false });
          } catch {
            /* ignore */
          }
        }
      },
      [bufferSearch]
    );

    const handleSearchInput = useCallback(
      (value: string) => {
        setSearchText(value);
        if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
        searchDebounceRef.current = setTimeout(() => {
          doSearch(value, searchStateRef.current.filterText, searchStateRef.current.caseSensitive);
        }, 150);
      },
      [doSearch]
    );

    const handleFilterInput = useCallback(
      (value: string) => {
        setFilterText(value);
        if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
        searchDebounceRef.current = setTimeout(() => {
          doSearch(searchStateRef.current.text, value, searchStateRef.current.caseSensitive);
        }, 150);
      },
      [doSearch]
    );

    const toggleSearchCase = useCallback(() => {
      const next = !searchStateRef.current.caseSensitive;
      setSearchCaseSensitive(next);
      searchStateRef.current.caseSensitive = next;
      doSearch(searchStateRef.current.text, searchStateRef.current.filterText, next);
    }, [doSearch]);

    const toggleFilter = useCallback(() => {
      setFilterEnabled((prev) => {
        if (prev) {
          setFilterText('');
          doSearch(searchStateRef.current.text, '', searchStateRef.current.caseSensitive);
        }
        return !prev;
      });
      setTimeout(() => filterInputRef.current?.focus(), 50);
    }, [doSearch]);

    const openSearch = useCallback(() => {
      setSearchVisible(true);
      setTimeout(() => searchInputRef.current?.focus(), 50);
    }, []);

    const closeSearch = useCallback(() => {
      setSearchVisible(false);
      setSearchText('');
      setSearchCaseSensitive(false);
      setFilterEnabled(false);
      setFilterText('');
      searchPosRef.current = -1;
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
      try {
        searchAddonRef.current?.findNext('');
      } catch {
        /* ignore */
      }
    }, []);

    // 监听 Ctrl+F 快捷键（全局快捷键可能被终端 textarea 拦截，所以在此额外监听）
    useEffect(() => {
      const handler = () => {
        if (isActive) openSearch();
      };
      window.addEventListener('qserial:open-search', handler);
      return () => window.removeEventListener('qserial:open-search', handler);
    }, [isActive, openSearch]);

    // 开始实时日志记录
    const handleStartLog = async () => {
      setLogStarting(true);
      try {
        const defaultName = session
          ? `${session.connectionType}-log-${new Date().toISOString().slice(0, 10)}.txt`
          : `terminal-log-${new Date().toISOString().slice(0, 10)}.txt`;

        const filePath = await window.qserial.log.pickFile(defaultName);
        if (!filePath) {
          setLogStarting(false);
          return;
        }

        await window.qserial.log.start(sessionId, filePath);
        startLog(sessionId, filePath);
      } catch (error) {
        console.error('Failed to start log:', error);
        globalError.show(t('terminalPane.logStartFailed') + ': ' + (error as Error).message);
      }
      setLogStarting(false);
    };

    // 停止日志记录
    const handleStopLog = async () => {
      try {
        await window.qserial.log.stop(sessionId);
        stopLog(sessionId);
      } catch (error) {
        console.error('Failed to stop log:', error);
      }
    };

    // 手动重连
    const handleReconnect = useCallback(async () => {
      if (reconnectLoading) return;
      setReconnectLoading(true);
      try {
        await window.qserial.connection.open(connectionId);
      } catch (error) {
        console.error('Failed to reconnect:', error);
        globalError.show(t('terminalPane.reconnectFailed') + ': ' + (error as Error).message);
      } finally {
        setReconnectLoading(false);
      }
    }, [connectionId, reconnectLoading]);

    const macroStore = useTerminalMacroStore;
    const { startRecording, stopRecording, saveMacro, addStep } = useTerminalMacroStore.getState();
    const handleStartRecord = useCallback(() => {
      startRecording();
      setIsRecording(true);
    }, [startRecording]);
    const handleStopRecord = useCallback(() => {
      stopRecording();
      setIsRecording(false);
      setShowMacroSave(true);
      setMacroDesc('');
      setMacroColor('');
    }, [stopRecording]);
    const handleSaveMacro = useCallback(() => {
      if (!macroName.trim()) return;
      const colorObj = PRESET_MACRO_COLORS.find((c) => c.value === macroColor);
      const saved = saveMacro(
        macroName.trim(),
        macroDesc.trim() || undefined,
        macroColor || undefined,
        colorObj?.textColor || undefined
      );
      setShowMacroSave(false);
      setMacroName('');
      setMacroDesc('');
      setMacroColor('');
      const qbs = useQuickButtonsStore.getState();
      if (qbs.groups.length === 0) {
        qbs.addGroup(t('terminalPane.defaultGroup'));
      }
      qbs.addButton(qbs.groups[0].id, {
        name: saved.name,
        command: '',
        macroId: saved.id,
        description: saved.description,
        color: saved.color,
        textColor: saved.textColor,
      });
    }, [macroName, macroDesc, macroColor, saveMacro]);

    const isLogging = session?.logEnabled ?? false;
    const isConnected = session?.connectionState === ConnectionState.CONNECTED;
    const isReconnecting = session?.connectionState === ConnectionState.RECONNECTING;
    const isDisconnected = session?.connectionState === ConnectionState.DISCONNECTED;
    const isError = session?.connectionState === ConnectionState.ERROR;
    const isConnectionActive = isConnected || isReconnecting;
    // 所有活跃连接都可共享（排除本身就是共享服务端的连接）
    // 重连中的连接也保持可共享状态，共享服务会在源连接恢复后自动继续
    const canShare =
      isConnectionActive &&
      session?.connectionType !== ConnectionType.CONNECTION_SERVER &&
      session?.connectionType !== ConnectionType.SERIAL_SERVER;

    return (
      <div
        className="flex"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          visibility: isActive ? 'visible' : 'hidden',
        }}
      >
      <div
        ref={containerRef}
        className="terminal-container flex-1 relative"
        onContextMenu={(e) => {
          e.preventDefault();
        }}
      >
        {/* 控制按钮组 */}
        {isActive && (
          <div className="absolute top-2 right-2 z-10 flex gap-2">
            {/* P0: 暂停滚动按钮 */}
            <button
              onClick={() => {
                pauseScrollRef.current = !pauseScrollRef.current;
                setPauseScrollState(pauseScrollRef.current);
              }}
              className={`px-2 py-1 border rounded text-xs transition-colors flex items-center gap-1.5 ${
                pauseScrollState
                  ? 'bg-warning/20 border-warning/50 text-warning'
                  : 'bg-surface/80 border-border hover:bg-hover'
              }`}
              title={pauseScrollState ? t('terminalPane.resumeScroll', '恢复滚动') : t('terminalPane.pauseScroll', '暂停滚动')}
            >
              {pauseScrollState ? (
                <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
                  <path d="M3 2L9 6L3 10Z" />
                </svg>
              ) : (
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <rect x="3" y="2" width="2" height="8" rx="0.5" fill="currentColor" />
                  <rect x="7" y="2" width="2" height="8" rx="0.5" fill="currentColor" />
                </svg>
              )}
              {pauseScrollState ? (t('terminalPane.paused', '已暂停')) : (t('terminalPane.pause', '暂停'))}
            </button>

            {/* 搜索栏 / 搜索按钮 */}
            {searchVisible ? (
              <div className="flex flex-col bg-surface/90 border border-primary/40 rounded">
                <div className="flex items-center gap-1.5 px-2 py-1">
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 12 12"
                    fill="none"
                    className="text-primary flex-shrink-0"
                  >
                    <circle cx="5" cy="5" r="3.5" stroke="currentColor" strokeWidth="1.2" />
                    <path
                      d="M7.5 7.5L10.5 10.5"
                      stroke="currentColor"
                      strokeWidth="1.2"
                      strokeLinecap="round"
                    />
                  </svg>
                  <input
                    ref={searchInputRef}
                    type="text"
                    value={searchText}
                    onChange={(e) => handleSearchInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        if (e.shiftKey) findPrevious();
                        else findNext();
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        closeSearch();
                      }
                    }}
                    className="bg-transparent text-xs text-text outline-none w-36 placeholder:text-text-tertiary/50"
                    placeholder={t('terminalPane.searchPlaceholder')}
                  />
                  <button
                    onClick={findPrevious}
                    className="text-text-secondary/60 hover:text-text transition-colors p-0.5"
                    title={t('terminalPane.prev')}
                  >
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                      <path
                        d="M3 7.5L6 4.5l3 3"
                        stroke="currentColor"
                        strokeWidth="1.2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                  <button
                    onClick={findNext}
                    className="text-text-secondary/60 hover:text-text transition-colors p-0.5"
                    title={t('terminalPane.next')}
                  >
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                      <path
                        d="M3 4.5L6 7.5l3-3"
                        stroke="currentColor"
                        strokeWidth="1.2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                  <button
                    onClick={toggleSearchCase}
                    className={`text-[11px] leading-none px-1 py-0.5 rounded transition-colors ${
                      searchCaseSensitive
                        ? 'bg-primary/30 text-primary'
                        : 'text-text-secondary/50 hover:text-text-secondary'
                    }`}
                    title={t('terminalPane.caseSensitive')}
                  >
                    Aa
                  </button>
                  <button
                    onClick={toggleFilter}
                    className={`p-0.5 rounded transition-colors ${
                      filterEnabled
                        ? 'bg-accent/30 text-accent'
                        : 'text-text-secondary/50 hover:text-text-secondary'
                    }`}
                    title={t('terminalPane.secondFilter')}
                  >
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                      <path
                        d="M1 2h10L7 6.5V10l-2 1V6.5L1 2z"
                        stroke="currentColor"
                        strokeWidth="1.1"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                  <button
                    onClick={closeSearch}
                    className="text-text-secondary/50 hover:text-text transition-colors p-0.5"
                    title={t('terminalPane.close')}
                  >
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                      <path
                        d="M3 3l6 6M9 3l-6 6"
                        stroke="currentColor"
                        strokeWidth="1.2"
                        strokeLinecap="round"
                      />
                    </svg>
                  </button>
                </div>
                {filterEnabled && (
                  <div className="flex items-center gap-1.5 px-2 pb-1 border-t border-border/50">
                    <svg
                      width="10"
                      height="10"
                      viewBox="0 0 10 10"
                      fill="none"
                      className="text-accent flex-shrink-0 ml-0.5"
                    >
                      <path
                        d="M2 3l3 3 3-3"
                        stroke="currentColor"
                        strokeWidth="1.2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    <input
                      ref={filterInputRef}
                      type="text"
                      value={filterText}
                      onChange={(e) => handleFilterInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          if (e.shiftKey) findPrevious();
                          else findNext();
                        } else if (e.key === 'Escape') {
                          e.preventDefault();
                          closeSearch();
                        }
                      }}
                      className="bg-transparent text-xs text-text outline-none w-36 placeholder:text-text-tertiary/50"
                      placeholder={t('terminalPane.searchFilterPlaceholder')}
                    />
                  </div>
                )}
              </div>
            ) : (
              <button
                onClick={openSearch}
                className="px-2 py-1 border rounded text-xs transition-colors bg-surface/80 border-border hover:bg-hover flex items-center gap-1.5"
                title={t('terminalPane.searchTitle')}
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 12 12"
                  fill="none"
                  className="text-text-secondary"
                >
                  <circle cx="5" cy="5" r="3.5" stroke="currentColor" strokeWidth="1.2" />
                  <path
                    d="M7.5 7.5L10.5 10.5"
                    stroke="currentColor"
                    strokeWidth="1.2"
                    strokeLinecap="round"
                  />
                </svg>
                {t('terminalPane.search')}
              </button>
            )}

            {/* 日志控制按钮 */}
            <button
              onClick={isLogging ? handleStopLog : handleStartLog}
              disabled={logStarting}
              className={`px-2 py-1 border rounded text-xs transition-colors flex items-center gap-1.5 ${
                isLogging
                  ? 'bg-red-500/80 border-red-400 text-white hover:bg-red-600/80'
                  : 'bg-surface/80 border-border hover:bg-hover'
              }`}
              title={isLogging ? t('terminalPane.stopLog') : t('terminalPane.startLog')}
            >
              {logStarting ? (
                <>
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                    <circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="1.2" />
                    <path
                      d="M6 3v3l2 1"
                      stroke="currentColor"
                      strokeWidth="1.2"
                      strokeLinecap="round"
                    />
                  </svg>
                  {t('terminalPane.starting')}
                </>
              ) : isLogging ? (
                <>
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                    <rect
                      x="2"
                      y="2"
                      width="8"
                      height="8"
                      rx="1.5"
                      stroke="currentColor"
                      strokeWidth="1.2"
                    />
                    <path d="M4.5 2.5v7" stroke="currentColor" strokeWidth="0.8" />
                    <path d="M7.5 2.5v7" stroke="currentColor" strokeWidth="0.8" />
                  </svg>
                  {t('terminalPane.stopLogLabel')}
                </>
              ) : (
                <>
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 12 12"
                    fill="none"
                    className="text-primary"
                  >
                    <path
                      d="M2 2.5h6l2 2v6H2z"
                      stroke="currentColor"
                      strokeWidth="1.2"
                      strokeLinejoin="round"
                    />
                    <path d="M2 10.5v-8h4l.5 1.5H10" stroke="currentColor" strokeWidth="1.2" />
                    <path
                      d="M4 8l1.5 1.5L8 6.5"
                      stroke="currentColor"
                      strokeWidth="1.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  {t('terminalPane.startLogLabel')}
                </>
              )}
            </button>

            {/* 连接共享按钮 - 所有活跃连接可共享 */}
            {canShare && (
              <button
                onClick={() => setShowSerialShareDialog(true)}
                className="px-2 py-1 border rounded text-xs transition-colors bg-surface/80 border-border hover:bg-hover flex items-center gap-1.5"
                title={t('terminalPane.shareTitle')}
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="text-accent">
                  <path
                    d="M7 2.5l3 3-3 3"
                    stroke="currentColor"
                    strokeWidth="1.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M10 5.5H5a2 2 0 00-2 2v1"
                    stroke="currentColor"
                    strokeWidth="1.2"
                    strokeLinecap="round"
                  />
                  <circle cx="3" cy="9.5" r="1.2" stroke="currentColor" strokeWidth="0.8" />
                </svg>
                {t('terminalPane.share')}
              </button>
            )}

            {/* 宏录制按钮 */}
            <button
              onClick={isRecording ? handleStopRecord : handleStartRecord}
              className={`px-2 py-1 border rounded text-xs transition-colors flex items-center gap-1.5 ${isRecording ? 'bg-red-500/80 border-red-400 text-white hover:bg-red-600/80' : 'bg-surface/80 border-border hover:bg-hover'}`}
              title={
                isRecording
                  ? t('terminalPane.stopRecording', {
                      count: macroStore.getState().recordingSteps.length,
                    })
                  : t('terminalPane.startRecording')
              }
            >
              {isRecording ? (
                <>
                  <span className="w-2 h-2 rounded-full bg-white animate-pulse"></span>REC{' '}
                  {macroStore.getState().recordingSteps.length > 0
                    ? '(' + macroStore.getState().recordingSteps.length + ')'
                    : ''}
                </>
              ) : (
                <>
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 12 12"
                    fill="none"
                    className="text-error"
                  >
                    <circle cx="6" cy="6" r="4" stroke="currentColor" strokeWidth="1.2" />
                  </svg>
                  {t('terminalPane.record')}
                </>
              )}
            </button>

            {/* 重连按钮 - 手动重连（断开或出错时显示，服务端连接除外） */}
            {(isDisconnected || isError) &&
              session?.connectionType !== ConnectionType.CONNECTION_SERVER &&
              session?.connectionType !== ConnectionType.SERIAL_SERVER && (
                <button
                  onClick={handleReconnect}
                  disabled={reconnectLoading}
                  className={`px-2 py-1 border rounded text-xs transition-colors flex items-center gap-1.5 ${
                    reconnectLoading
                      ? 'bg-surface/80 border-border opacity-50'
                      : 'bg-blue-500/80 border-blue-400 text-white hover:bg-blue-600/80'
                  }`}
                  title={t('terminalPane.reconnectTitle')}
                >
                  {reconnectLoading ? (
                    <>
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                        <circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="1.2" />
                        <path
                          d="M6 3v3l2 1"
                          stroke="currentColor"
                          strokeWidth="1.2"
                          strokeLinecap="round"
                        />
                      </svg>
                      {t('terminalPane.connecting')}
                    </>
                  ) : (
                    <>
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                        <path
                          d="M2.5 5A4 4 0 019 3.5"
                          stroke="currentColor"
                          strokeWidth="1.2"
                          strokeLinecap="round"
                        />
                        <path
                          d="M9.5 7A4 4 0 013 8.5"
                          stroke="currentColor"
                          strokeWidth="1.2"
                          strokeLinecap="round"
                        />
                        <path
                          d="M9 1.5l1.5 2-2 1"
                          stroke="currentColor"
                          strokeWidth="1.2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                        <path
                          d="M3 10.5l-1.5-2 2-1"
                          stroke="currentColor"
                          strokeWidth="1.2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                      {t('terminalPane.reconnect')}
                    </>
                  )}
                </button>
              )}
          </div>
        )}
        {/* 日志文件路径提示 */}
        {isActive && isLogging && session?.logFilePath && (
          <div className="absolute top-10 right-2 z-10 px-2 py-1 bg-success/90 text-white rounded text-xs max-w-[200px] truncate">
            📄 {session.logFilePath.split(/[/\\]/).pop()}
          </div>
        )}

        {/* P0: 底部常驻命令输入框 */}
        {isActive && session?.connectionState === ConnectionState.CONNECTED && (
          <div className="absolute bottom-0 left-0 right-0 z-10 flex items-center gap-2 px-2 py-1.5 bg-surface/95 border-t border-border">
            <span className="text-success font-mono text-xs flex-shrink-0">&gt;</span>
            <input
              ref={cmdInputRef}
              type="text"
              value={cmdInputValue}
              onChange={(e) => setCmdInputValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  const cmd = cmdInputValue.trim();
                  if (!cmd || !connectionId) return;
                  // 发送到设备
                  const dataToSend = cmdMode === 'hex'
                    ? cmd.replace(/\s/g, '')
                    : cmd + '\n';
                  if (cmdMode === 'hex') {
                    // HEX 模式：转成二进制发送
                    try {
                      const hexData = dataToSend.match(/.{1,2}/g)?.map(h => parseInt(h, 16)) || [];
                      const uint8 = new Uint8Array(hexData);
                      const b64 = btoa(String.fromCharCode(...uint8));
                      window.qserial.connection.write(connectionId, b64);
                    } catch {
                      // HEX 解析失败，忽略
                    }
                  } else {
                    window.qserial.connection.write(connectionId, dataToSend);
                  }
                  // 写入终端显示（TX 蓝色 + 时间戳）
                  if (xtermRef.current) {
                    writeWithTimestamp(xtermRef.current, cmd + '\r\n', 'tx');
                  }

                  // P1: 如果是 AT 命令，标记为待追踪
                  if (/^AT/i.test(cmd)) {
                    pendingAtRef.current = { command: cmd, timestamp: Date.now() };
                    atResponseBufferRef.current = '';
                    // 先加一条 pending 记录
                    setAtTransactions((prev) =>
                      [
                        {
                          id: `at-${Date.now()}`,
                          command: cmd,
                          response: '',
                          status: 'pending' as const,
                          timestamp: Date.now(),
                          durationMs: 0,
                        },
                        ...prev,
                      ].slice(0, 50)
                    );
                  }

                  setCmdInputValue('');
                } else if (e.key === 'ArrowUp') {
                  // 简单的历史回溯（后续可扩展为完整历史列表）
                  e.preventDefault();
                }
              }}
              className="flex-1 px-2 py-1 bg-background text-text text-xs font-mono border border-border rounded focus:outline-none focus:border-primary transition-colors"
              placeholder={cmdMode === 'hex' ? '输入 HEX 数据，如 0D0A...' : '输入命令，Enter 发送...'}
            />
            <div className="flex gap-0.5 p-0.5 bg-background border border-border rounded">
              <button
                onClick={() => setCmdMode('text')}
                className={`px-2 py-0.5 text-[10px] font-medium rounded transition-colors ${
                  cmdMode === 'text' ? 'bg-surface text-text' : 'text-text-tertiary hover:text-text-secondary'
                }`}
              >
                {t('terminalPane.text', '文本')}
              </button>
              <button
                onClick={() => setCmdMode('hex')}
                className={`px-2 py-0.5 text-[10px] font-medium rounded transition-colors ${
                  cmdMode === 'hex' ? 'bg-surface text-text' : 'text-text-tertiary hover:text-text-secondary'
                }`}
              >
                HEX
              </button>
            </div>
            <button
              onClick={() => {
                const cmd = cmdInputValue.trim();
                if (!cmd || !connectionId) return;
                const dataToSend = cmd + '\n';
                window.qserial.connection.write(connectionId, dataToSend);
                if (xtermRef.current) {
                  writeWithTimestamp(xtermRef.current, cmd + '\r\n', 'tx');
                }
                setCmdInputValue('');
              }}
              className="px-3 py-1 text-xs font-medium bg-surface border border-border rounded text-text hover:border-primary transition-colors flex-shrink-0"
            >
              {t('terminalPane.send', '发送')}
            </button>
          </div>
        )}

        {/* 宏保存对话框 */}
        {showMacroSave && (
          <div className="dialog-overlay fixed inset-0 bg-black/50 flex items-center justify-center z-50">
            <div
              className="bg-surface border border-border/80 rounded-xl shadow-md w-[360px]"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between px-4 py-3 border-b border-border">
                <h3 className="text-sm font-medium">{t('terminalPane.saveMacroTitle')}</h3>
                <span className="text-xs text-text-secondary">
                  {t('terminalPane.steps', { count: macroStore.getState().recordingSteps.length })}
                </span>
              </div>
              <div className="p-4 space-y-3">
                <div>
                  <label className="block text-xs text-text-secondary mb-1.5 font-medium">
                    {t('terminalPane.name')}
                  </label>
                  <input
                    type="text"
                    value={macroName}
                    onChange={(e) => setMacroName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleSaveMacro();
                      else if (e.key === 'Escape') {
                        setShowMacroSave(false);
                        setMacroName('');
                        setMacroDesc('');
                        setMacroColor('');
                      }
                    }}
                    className="dialog-input"
                    placeholder={t('terminalPane.namePlaceholder')}
                    autoFocus
                  />
                </div>
                <div>
                  <label className="block text-xs text-text-secondary mb-1.5 font-medium">
                    {t('terminalPane.descriptionOptional')}
                  </label>
                  <input
                    type="text"
                    value={macroDesc}
                    onChange={(e) => setMacroDesc(e.target.value)}
                    className="dialog-input"
                    placeholder={t('terminalPane.descriptionPlaceholder')}
                  />
                </div>
                <div>
                  <label className="block text-xs text-text-secondary mb-1.5 font-medium">
                    {t('terminalPane.colorMarkOptional')}
                  </label>
                  <div className="flex flex-wrap gap-1.5">
                    {PRESET_MACRO_COLORS.map((c) => (
                      <button
                        key={c.value || 'default'}
                        onClick={() => setMacroColor(c.value)}
                        className={`w-5 h-5 rounded border-2 transition-all ${macroColor === c.value ? 'border-white scale-110' : 'border-transparent'}`}
                        style={{ backgroundColor: c.value || '#6B7280' }}
                        title={c.name}
                      />
                    ))}
                  </div>
                </div>
                <div className="flex justify-end gap-2">
                  <button
                    onClick={() => {
                      setShowMacroSave(false);
                      setMacroName('');
                      setMacroDesc('');
                      setMacroColor('');
                    }}
                    className="px-3 py-1.5 text-xs rounded border border-border hover:bg-hover"
                  >
                    {t('terminalPane.cancel')}
                  </button>
                  <button
                    onClick={handleSaveMacro}
                    disabled={!macroName.trim()}
                    className="px-3 py-1.5 text-xs rounded bg-primary text-white disabled:opacity-50"
                  >
                    {t('terminalPane.save')}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* 串口共享对话框 */}
        <ConnectionShareDialog
          isOpen={showSerialShareDialog}
          onClose={() => setShowSerialShareDialog(false)}
          defaultSessionId={sessionId}
        />
      </div>

      {/* P1: AT 事务面板 */}
      {isActive && (
        <AtTransactionPanel
          transactions={atTransactions}
          onClear={() => setAtTransactions([])}
        />
      )}
    </div>
    );
  }
);

TerminalPane.displayName = 'TerminalPane';
