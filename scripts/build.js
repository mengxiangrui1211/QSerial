import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { request } from 'http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const isDev = process.argv.includes('--dev');
const VITE_PORT = parseInt(process.env.VITE_PORT || '5173', 10);

// 跟踪所有子进程，确保退出时彻底清理
const childProcesses = new Set();
let isShuttingDown = false;

function killProcessTree(proc) {
  if (!proc || proc.killed) return;
  try {
    // 先断开 stdin pipe，防止子进程 read() 被 SIGTERM 中断时触发 EIO 错误
    if (proc.stdin && !proc.stdin.destroyed) {
      proc.stdin.end();
      proc.stdin.destroy();
    }

    if (process.platform === 'win32') {
      // Windows: 用 taskkill /T 杀掉整个进程树
      spawn('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { stdio: 'ignore' });
    } else {
      // Linux/macOS: 杀进程组 (shell + pnpm + vite + electron 全部终止)
      process.kill(-proc.pid, 'SIGTERM');
    }
  } catch {
    // 兜底：直接杀当前进程
    try { proc.kill('SIGTERM'); } catch { /* ignore */ }
  }
}

function cleanupAll() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  for (const proc of childProcesses) {
    killProcessTree(proc);
  }
  // 给子进程 2 秒优雅退出，然后强制退出
  setTimeout(() => {
    process.exit(0);
  }, 2000);
}

// 确保 Ctrl+C / SIGTERM 时彻底清理
process.on('SIGINT', () => cleanupAll());
process.on('SIGTERM', () => cleanupAll());

function trackedSpawn(cmd, args, opts) {
  // stdin 用 pipe（不继承终端 TTY），stdout/stderr 继承，避免子进程 readline 在退出时触发 EIO
  const proc = spawn(cmd, args, { ...opts, stdio: ['pipe', 'inherit', 'inherit'] });
  // 立即关闭 stdin pipe 的写入端，子进程读到 EOF 而非 EIO
  if (proc.stdin) {
    proc.stdin.end();
    proc.stdin.destroy();
  }
  childProcesses.add(proc);
  proc.on('close', () => childProcesses.delete(proc));
  proc.on('exit', () => childProcesses.delete(proc));
  return proc;
}

function waitForPort(port, timeout = 30000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const req = request({ hostname: 'localhost', port, method: 'HEAD', timeout: 500 }, () => {
        req.destroy();
        resolve();
      });
      req.on('error', () => {
        req.destroy();
        if (Date.now() - start > timeout) {
          reject(new Error(`Timeout waiting for port ${port}`));
        } else {
          setTimeout(check, 300);
        }
      });
      req.end();
    };
    check();
  });
}

// 构建共享包
console.log('Building shared package...');
const buildShared = trackedSpawn('pnpm', ['build:shared'], {
  cwd: path.join(__dirname, '..'),
  shell: true,
});

buildShared.on('close', (code) => {
  if (code !== 0) {
    console.error('Failed to build shared package');
    cleanupAll();
    return;
  }

  // 构建主进程
  console.log('Building main process...');
  const buildMain = trackedSpawn('pnpm', ['build:main'], {
    cwd: path.join(__dirname, '..'),
    shell: true,
  });

  buildMain.on('close', (code) => {
    if (code !== 0) {
      console.error('Failed to build main process');
      cleanupAll();
      return;
    }

    if (isDev) {
      // 开发模式：启动 Vite 和 Electron
      console.log('Starting development servers...');

      // 启动渲染进程开发服务器
      const vite = trackedSpawn('pnpm', ['dev:renderer'], {
        cwd: path.join(__dirname, '..'),
        shell: true,
      });

      // 等待 Vite 启动后启动 Electron
      waitForPort(VITE_PORT).then(() => {
        console.log(`Vite ready on port ${VITE_PORT}, starting Electron...`);
        const electron = trackedSpawn('electron', ['packages/main/dist/index.js'], {
          cwd: path.join(__dirname, '..'),
          shell: true,
          env: { ...process.env, NODE_ENV: 'development' },
        });

        electron.on('close', () => {
          // Electron 窗口关闭后，彻底清理 Vite 进程树再退出
          killProcessTree(vite);
          cleanupAll();
        });
      }).catch((err) => {
        console.error(err.message);
        killProcessTree(vite);
        cleanupAll();
      });
    } else {
      // 生产模式：构建渲染进程
      console.log('Building renderer...');
      const buildRenderer = trackedSpawn('pnpm', ['build:renderer'], {
        cwd: path.join(__dirname, '..'),
        shell: true,
      });

      buildRenderer.on('close', (code) => {
        if (code !== 0) {
          console.error('Failed to build renderer');
          process.exit(1);
        }
        console.log('Build complete!');
      });
    }
  });
});
