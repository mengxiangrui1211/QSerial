/**
 * MCP 服务器状态管理
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { McpServerStatus } from '@qserial/shared';

interface McpConfig {
  port: number;
  listenAddress: string;
  authPassword: string;
  corsOrigins: string;
  autoStart: boolean;
}

interface McpConnection {
  id: string;
  type: string;
  name: string;
  state: string;
}

interface McpState {
  config: McpConfig;
  running: boolean;
  starting: boolean;
  stopping: boolean;
  error?: string;
  connections: McpConnection[];
  activeToken?: string;
}

interface McpActions {
  updateConfig: (config: Partial<McpConfig>) => void;
  setRunning: (running: boolean) => void;
  setError: (error?: string) => void;
  startServer: () => Promise<void>;
  stopServer: () => Promise<void>;
  loadStatus: () => Promise<void>;
}

const DEFAULT_CONFIG: McpConfig = {
  port: 9800,
  listenAddress: '127.0.0.1',
  authPassword: '',
  corsOrigins: '',
  autoStart: false,
};

export const useMcpStore = create<McpState & McpActions>()(
  persist(
    (set, get) => ({
      config: DEFAULT_CONFIG,
      running: false,
      starting: false,
      stopping: false,
      error: undefined,
      connections: [],
      activeToken: undefined,

      updateConfig: (config) => {
        set((state) => ({
          config: { ...state.config, ...config },
        }));
      },

      setRunning: (running) => {
        set({ running, error: undefined });
      },

      setError: (error) => {
        set({ error, running: false });
      },

      startServer: async () => {
        const { config, starting } = get();
        if (starting) return;
        set({ starting: true, stopping: false, error: undefined });
        try {
          const corsArr = config.corsOrigins
            ? config.corsOrigins
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean)
            : undefined;
          await window.qserial.mcp.start(
            config.port,
            config.listenAddress,
            config.authPassword || undefined,
            true,
            corsArr
          );
          set({ running: true, starting: false, error: undefined });
        } catch (error) {
          set({ error: (error as Error).message, running: false, starting: false });
        }
      },

      stopServer: async () => {
        set({ starting: false, stopping: true });
        try {
          await window.qserial.mcp.stop(false);
          set({
            running: false,
            stopping: false,
            error: undefined,
            connections: [],
            activeToken: undefined,
          });
        } catch (error) {
          set({ error: (error as Error).message, stopping: false });
        }
      },

      loadStatus: async () => {
        try {
          const status: McpServerStatus = await window.qserial.mcp.getStatus();
          const state = get();
          if (state.starting || state.stopping) return;
          if (status.running) {
            // 仅在数据实际变化时才更新，避免无意义的重渲染导致滚动卡顿
            const portChanged = status.port !== undefined && status.port !== state.config.port;
            const addrChanged =
              status.listenAddress !== undefined &&
              status.listenAddress !== state.config.listenAddress;
            const tokenChanged = (status.token || undefined) !== state.activeToken;
            const connChanged =
              status.connections.length !== state.connections.length ||
              status.connections.some(
                (c, i) =>
                  c.id !== state.connections[i]?.id || c.state !== state.connections[i]?.state
              );

            if (!portChanged && !addrChanged && !tokenChanged && !connChanged && state.running) {
              return; // 无变化，跳过更新
            }

            set({
              running: true,
              config:
                portChanged || addrChanged
                  ? {
                      ...state.config,
                      port: status.port ?? state.config.port,
                      listenAddress: status.listenAddress ?? state.config.listenAddress,
                    }
                  : state.config,
              connections: connChanged ? status.connections : state.connections,
              activeToken: tokenChanged ? status.token || undefined : state.activeToken,
            });
          } else {
            if (!state.running && state.connections.length === 0) return; // 已经是停止状态，跳过
            if (state.running) {
              console.log(
                '[MCP] loadStatus: main process reports not running, syncing state to false'
              );
            }
            set({ running: false, connections: [] });
          }
        } catch (error) {
          console.error('Failed to load MCP status:', error);
        }
      },
    }),
    {
      name: 'qserial-mcp',
      partialize: (state) => ({ config: state.config }),
    }
  )
);

// 监听主进程的 MCP 状态变化事件
let listenersInitialized = false;

export function initMcpListeners(): void {
  if (listenersInitialized) return;
  listenersInitialized = true;

  window.qserial.mcp.onStatusChange((event) => {
    const state = useMcpStore.getState();
    if (!event.running) {
      if (state.starting) return;
      if (state.stopping) return;
      if (!state.running) return;
      useMcpStore.setState({ running: false, starting: false, stopping: false });
    } else {
      if (!state.running) {
        useMcpStore.setState({ running: true, starting: false });
      }
    }
  });

  // MCP 创建连接 → 自动在 GUI 打开标签页
  window.qserial.mcp.onConnectionCreated(async (event) => {
    const { useTerminalStore } = await import('@/stores/terminal');
    const store = useTerminalStore.getState();
    store.createTab(event.name);
    const ConnectionType = (await import('@qserial/shared')).ConnectionType;
    store.createSession(
      event.connectionId,
      event.type as (typeof ConnectionType)[keyof typeof ConnectionType],
      event.path,
      event.host,
      event.savedSessionId
    );
  });
}
