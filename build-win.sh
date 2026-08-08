#!/bin/bash
# QSerial Windows 安装包一键编译 + 阿里云部署脚本
# 用法:
#   ./build-win.sh               只编译(NSIS 安装包 + portable 单文件 + win-unpacked)
#   ./build-win.sh --deploy      编译并部署到阿里云服务器(需要 .env 配置)
#   ./build-win.sh --help        查看帮助

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

DEPLOY=0

usage() {
  cat <<'EOF'
QSerial Windows 一键编译脚本

用法:
  ./build-win.sh [--deploy] [--help]

选项:
  --deploy   编译完成后将安装包上传到阿里云服务器(读取 .env 配置)
  --help     显示本帮助

前置要求:
  node >= 20、pnpm、python3(用于生成 ICO 图标)
  部署模式额外需要:
    cp .env.example .env   # 填写 QSERIAL_HOST / QSERIAL_USER / QSERIAL_WEB_ROOT
    本机可 ssh/scp 免密登录目标服务器
EOF
}

for arg in "$@"; do
  case "$arg" in
    --deploy|-d) DEPLOY=1 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "未知参数: $arg"; usage; exit 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# 自动配置 PATH:检测常用 Node/pnpm 安装路径
for dir in /opt/node-v23.6.0-linux-x64/bin /opt/node-v18.20.6-linux-x64/bin /root/.npm-global/bin /usr/local/bin; do
  case ":$PATH:" in
    *":$dir:"*) ;;
    *) export PATH="$dir:$PATH" ;;
  esac
done

echo ""
echo "=========================================="
echo "  QSerial Windows 安装包一键编译"
if [ "$DEPLOY" -eq 1 ]; then
  echo "  模式: 编译 + 部署到阿里云"
else
  echo "  模式: 仅编译"
fi
echo "=========================================="
echo ""

# 环境检查
check_command() {
  if ! command -v "$1" &>/dev/null; then
    echo -e "${RED}错误: 未找到 $1,请先安装${NC}"
    exit 1
  fi
}

echo -e "${YELLOW}[1/6] 检查环境...${NC}"
check_command node

# 如果 pnpm 不在 PATH 中,通过 npx 调用
if command -v pnpm &>/dev/null; then
  PNPM=pnpm
else
  echo "  pnpm 未在 PATH 中,将通过 npx pnpm 调用"
  PNPM="npx pnpm"
fi

echo "  Node: $(node --version)"
echo "  pnpm: $($PNPM --version)"
echo ""

# NSIS 安装包在 Linux 上需要 wine(用于提取 uninstaller);
# portable 单文件和 win-unpacked 不需要。有 wine 就构建安装包,否则只构建免安装版。
if command -v wine &>/dev/null; then
  HAS_WINE=1
  WIN_TARGETS="nsis portable"
else
  HAS_WINE=0
  WIN_TARGETS="portable"
  echo -e "${YELLOW}  提示: 未检测到 wine,将跳过 NSIS 安装包(仅构建免安装版)。${NC}"
  echo -e "${YELLOW}  如需安装包,请先安装 wine (Debian/Ubuntu: sudo apt install wine) 后重新运行。${NC}"
  echo ""
fi

# 设置环境变量
export CSC_IDENTITY_AUTO_DISCOVERY=false
# 抑制第三方原生模块(cpu-features 等)的 C++ 编译警告
export CFLAGS="-Wno-cast-function-type"
export CXXFLAGS="-Wno-cast-function-type"
# 绕过 /home/qcc/.npmrc 目录挂载导致的 EISDIR 警告
export npm_config_userconfig="${TMPDIR:-/tmp}/npmrc"
touch "$npm_config_userconfig" 2>/dev/null || true

# 安装依赖
echo -e "${YELLOW}[2/6] 安装依赖...${NC}"
$PNPM install --engine-strict=false
echo -e "${GREEN}  ✓ 依赖安装完成${NC}"
echo ""

# 生成 ICO 图标(32bpp,小尺寸 BMP + 大尺寸 PNG)
echo -e "${YELLOW}  生成 ICO 图标...${NC}"
check_command python3
python3 "$(dirname "$0")/scripts/gen_icon_ico.py"
echo -e "${GREEN}  ✓ ICO 图标生成完成${NC}"

# 构建 TypeScript
echo -e "${YELLOW}[3/6] 构建项目...${NC}"
# 生成 electron-builder 运行时依赖映射
node scripts/gen-deps-mapping.cjs
# 准备 ftp-srv 依赖(打平安装到 resources/ftp-node-modules)
node scripts/prepare-ftp-deps.cjs
$PNPM build:shared
$PNPM build:main
$PNPM build:renderer
echo -e "${GREEN}  ✓ 项目构建完成${NC}"
echo ""

if [ "$HAS_WINE" -eq 1 ]; then
  echo -e "${YELLOW}[4/6] 打包 Windows 安装包(NSIS 安装版 + portable 免安装版)...${NC}"
else
  echo -e "${YELLOW}[4/6] 打包 Windows 免安装版(portable + win-unpacked)...${NC}"
fi

# WSL2 drvfs (9P) 文件系统下,electron-builder 自清理旧产物时可能
# 遇到 I/O error 或 Permission denied,因为文件被 Windows 侧锁死。
# 解决方案:将 electron-builder 输出定向到 Linux 原生文件系统 (/tmp),
# 构建完成后再复制回 release/。
BUILD_TMP="$(mktemp -d /tmp/qserial-build-XXXXXX)"

# 生成临时 electron-builder 配置:输出到 Linux 原生文件系统
cat > "$BUILD_TMP/eb-config.cjs" << EBEOF
const base = require('$(pwd)/electron-builder.config.cjs');
module.exports = {
  ...base,
  directories: { ...base.directories, output: '$BUILD_TMP/output' },
};
EBEOF

npx electron-builder --win $WIN_TARGETS --x64 -c "$BUILD_TMP/eb-config.cjs"

# 复制安装包与 portable 单文件到 release/
mkdir -p release
cp -f "$BUILD_TMP"/output/QSerial-*-x64-win.exe release/ 2>/dev/null || true
cp -f "$BUILD_TMP"/output/QSerial-*-x64-win-portable.exe release/ 2>/dev/null || true

TMP_UNPACKED="$BUILD_TMP/output/win-unpacked"

# 在 Linux 原生 fs 上修复 node-pty(后续复制时会一起带走)
echo "  修复 node-pty..."
node scripts/fix-node-pty-release.cjs "$TMP_UNPACKED"

# 在 Linux 原生 fs 上设置 exe 图标
if [ -f "$TMP_UNPACKED/QSerial.exe" ]; then
  echo "  设置 exe 图标..."
  node scripts/set-icon.cjs "$TMP_UNPACKED/QSerial.exe" "$(pwd)/build/icon.ico"
fi

# 复制 win-unpacked 到 release/
# 旧 win-unpacked 目录可能因 WSL2 drvfs 锁死,先尝试直接清理
rm -rf release/win-unpacked 2>/dev/null || true

if [ -d "release/win-unpacked" ]; then
  # 清理失败,旧文件被 Windows 锁死,使用带时间戳的新目录
  FALLBACK_DIR="release/win-unpacked-$(date +%Y%m%d-%H%M%S)"
  echo -e "${YELLOW}  旧 release/win-unpacked 清理失败(文件被 Windows 锁死)${NC}"
  echo -e "${YELLOW}  改输出到 $FALLBACK_DIR${NC}"
  echo -e "${YELLOW}  请在 Windows 资源管理器中手动删除锁死的 release/win-unpacked 目录${NC}"
  mkdir -p "$FALLBACK_DIR"
  cp -r "$TMP_UNPACKED"/* "$FALLBACK_DIR"/
  WIN_UNPACKED_DIR="$FALLBACK_DIR"
else
  # 旧目录清理成功,正常使用
  mkdir -p release/win-unpacked
  echo "  复制产物到 release/win-unpacked/ ..."
  cp -r "$TMP_UNPACKED"/* release/win-unpacked/
  WIN_UNPACKED_DIR="release/win-unpacked"
fi

# 清理临时目录
rm -rf "$BUILD_TMP"
echo -e "${GREEN}  ✓ 打包完成${NC}"
echo ""

# 检查结果
echo -e "${YELLOW}[5/6] 检查输出...${NC}"
VERSION="$(node -p "require('./package.json').version")"
INSTALLER="release/QSerial-$VERSION-x64-win.exe"
PORTABLE_EXE="release/QSerial-$VERSION-x64-win-portable.exe"

check_output() {
  local file="$1"
  local label="$2"
  if [ -f "$file" ]; then
    local size
    size="$(ls -lh "$file" | awk '{print $5}')"
    echo -e "${GREEN}  ✓ $label: $file ($size)${NC}"
  else
    echo -e "${RED}  ✗ 缺少 $label: $file${NC}"
    exit 1
  fi
}

if [ "$HAS_WINE" -eq 1 ]; then
  check_output "$INSTALLER" "NSIS 安装包"
else
  echo -e "${YELLOW}  - 跳过 NSIS 安装包(需要 wine): $INSTALLER${NC}"
fi
check_output "$PORTABLE_EXE" "portable 单文件"

if [ -f "$WIN_UNPACKED_DIR/QSerial.exe" ]; then
  chmod +x "$WIN_UNPACKED_DIR/QSerial.exe" "$WIN_UNPACKED_DIR"/*.dll 2>/dev/null || true
  EXE_SIZE="$(ls -lh "$WIN_UNPACKED_DIR/QSerial.exe" | awk '{print $5}')"
  echo -e "${GREEN}  ✓ 免安装目录: $WIN_UNPACKED_DIR/QSerial.exe ($EXE_SIZE)${NC}"
else
  echo -e "${RED}  ✗ 未找到 $WIN_UNPACKED_DIR/QSerial.exe,构建可能失败${NC}"
  exit 1
fi

# 部署到阿里云服务器
if [ "$DEPLOY" -eq 1 ]; then
  echo ""
  echo -e "${YELLOW}[6/6] 部署到阿里云服务器...${NC}"
  if [ ! -f ".env" ]; then
    echo -e "${RED}  未找到 .env,请先执行:${NC}"
    echo -e "${YELLOW}    cp .env.example .env${NC}"
    echo -e "${RED}  然后填写 QSERIAL_HOST / QSERIAL_USER / QSERIAL_WEB_ROOT${NC}"
    exit 1
  fi

  node scripts/deploy.cjs --release

  if [ "$HAS_WINE" -ne 1 ]; then
    echo -e "${YELLOW}  注: 本次仅部署 portable 免安装版(未构建 NSIS 安装包)${NC}"
  fi

  DEPLOY_HOST="$(sed -n 's/^QSERIAL_HOST=//p' .env | tail -1 | tr -d '[:space:]')"
  if [ -n "$DEPLOY_HOST" ]; then
    echo ""
    echo -e "${GREEN}  下载地址:${NC}"
    echo -e "${GREEN}    安装包:  http://$DEPLOY_HOST/download/installer/$(basename "$INSTALLER")${NC}"
    echo -e "${GREEN}    免安装:  http://$DEPLOY_HOST/download/portable/$(basename "$PORTABLE_EXE")${NC}"
  fi
fi

echo ""
echo "=========================================="
echo -e "${GREEN}  编译完成!${NC}"
echo "=========================================="
