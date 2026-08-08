const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { Client } = require('ssh2');

const ROOT = path.resolve(__dirname, '..');

// Load .env file
function loadEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) {
    console.error('Error: .env file not found. Copy .env.example to .env and fill in your server info.');
    process.exit(1);
  }
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}
loadEnv();

const SERVER_HOST = process.env.QSERIAL_HOST;
const SERVER_USER = process.env.QSERIAL_USER;
const WEB_ROOT = process.env.QSERIAL_WEB_ROOT || '/opt/qserial/website';
const SERVER_PASS = process.env.QSERIAL_PASS;

if (!SERVER_HOST || !SERVER_USER) {
  console.error('Error: QSERIAL_HOST and QSERIAL_USER must be set in .env');
  process.exit(1);
}

// 统一远程操作:配置了 QSERIAL_PASS 时用 ssh2 密码认证,
// 否则回退到系统 scp/ssh(密钥认证)。
function remoteExec(cmd) {
  if (SERVER_PASS) {
    return new Promise((resolve, reject) => {
      const conn = new Client();
      conn.on('ready', () => {
        conn.exec(cmd, (err, stream) => {
          if (err) {
            conn.end();
            return reject(err);
          }
          stream.on('close', (code) => {
            conn.end();
            if (code === 0) resolve();
            else reject(new Error(`remote command failed (${code}): ${cmd}`));
          });
          stream.on('data', (d) => process.stdout.write(d));
          stream.stderr.on('data', (d) => process.stderr.write(d));
        });
      });
      conn.on('error', reject);
      conn.connect({ host: SERVER_HOST, username: SERVER_USER, password: SERVER_PASS });
    });
  }
  execSync(cmd, { stdio: 'inherit', cwd: ROOT });
}

function uploadFile(src, dest) {
  const label = path.basename(src);
  if (SERVER_PASS) {
    return new Promise((resolve, reject) => {
      const stat = fs.statSync(src);
      const sizeMB = (stat.size / 1048576).toFixed(0);
      console.log(`  → ${label} (${sizeMB} MB)  =>  ${SERVER_USER}@${SERVER_HOST}:${dest}`);
      const conn = new Client();
      conn.on('ready', () => {
        conn.sftp((err, sftp) => {
          if (err) {
            conn.end();
            return reject(err);
          }
          const ws = sftp.createWriteStream(dest, { mode: 0o644 });
          ws.on('close', () => {
            conn.end();
            console.log(`  ✅ ${label} 上传完成`);
            resolve();
          });
          ws.on('error', (e) => {
            conn.end();
            reject(e);
          });
          fs.createReadStream(src).pipe(ws);
        });
      });
      conn.on('error', reject);
      conn.connect({ host: SERVER_HOST, username: SERVER_USER, password: SERVER_PASS });
    });
  }
  const cmd = `scp -C ${src} ${SERVER_USER}@${SERVER_HOST}:${dest}`;
  console.log(`  → ${label}  =>  ${SERVER_USER}@${SERVER_HOST}:${dest}`);
  execSync(cmd, { stdio: 'inherit', cwd: ROOT });
}

async function targetWebsite() {
  console.log('\n📄 部署网站页面...');
  await uploadFile(path.join(ROOT, 'website/index.html'), `${WEB_ROOT}/index.html`);
  console.log('✅ 网站页面部署完成\n');
}

async function targetRelease() {
  const releaseDir = path.join(ROOT, 'release');
  const { version } = require(path.join(ROOT, 'package.json'));

  // 确保服务端子目录存在
  const mkdir = SERVER_PASS
    ? `mkdir -p ${WEB_ROOT}/download/installer ${WEB_ROOT}/download/portable`
    : `ssh ${SERVER_USER}@${SERVER_HOST} "mkdir -p ${WEB_ROOT}/download/installer ${WEB_ROOT}/download/portable"`;
  if (!SERVER_PASS) {
    console.log('  → 创建子目录...');
  }
  await remoteExec(mkdir);

  const installerExe = path.join(releaseDir, `QSerial-${version}-x64-win.exe`);
  const portableExe = path.join(releaseDir, `QSerial-${version}-x64-win-portable.exe`);

  let uploaded = 0;
  if (fs.existsSync(installerExe)) {
    console.log('\n📦 部署 NSIS 安装包...');
    await uploadFile(installerExe, `${WEB_ROOT}/download/installer/${path.basename(installerExe)}`);
    uploaded++;
  } else {
    console.log(`⚠️  缺少 NSIS 安装包，跳过: ${path.basename(installerExe)}`);
  }

  if (fs.existsSync(portableExe)) {
    console.log('\n📦 部署 portable 免安装版...');
    await uploadFile(portableExe, `${WEB_ROOT}/download/portable/${path.basename(portableExe)}`);
    uploaded++;
  } else {
    console.log(`⚠️  缺少 portable 免安装版，跳过: ${path.basename(portableExe)}`);
  }

  if (uploaded === 0) {
    console.log('⚠️  release/ 目录没有可部署的安装包，请先运行 pnpm run package:win 或 ./build-win.sh\n');
  } else {
    console.log(`✅ 安装包部署完成 (${uploaded} 个文件)\n`);
  }
}

async function targetNginx() {
  console.log('\n🔧 部署 Nginx 配置...');
  await uploadFile(
    path.join(ROOT, 'website/qserial-nginx.conf'),
    '/etc/nginx/sites-available/qserial'
  );
  const reload = SERVER_PASS
    ? `nginx -t && nginx -s reload`
    : `ssh ${SERVER_USER}@${SERVER_HOST} "nginx -t && nginx -s reload"`;
  console.log('  → nginx -t && nginx -s reload');
  await remoteExec(reload);
  console.log('✅ Nginx 配置部署完成\n');
}

function printUsage() {
  console.log(`
用法: node scripts/deploy.cjs <target>

  --website   只部署网站页面 (index.html)
  --release   只部署安装包 (release/*.exe)
  --nginx     只部署 Nginx 配置并 reload
  --all       部署全部 (默认)

环境变量:
  QSERIAL_HOST      服务器地址 (.env)
  QSERIAL_USER      SSH 用户   (.env)
  QSERIAL_PASS      SSH 密码   (.env,可选;不填则使用本机 SSH 密钥)
`);
}

async function main() {
  const args = process.argv.slice(2);
  const targets = new Set(args.length === 0 ? ['--all'] : args);

  if (targets.has('--help') || targets.has('-h')) {
    printUsage();
    return;
  }

  const all = targets.has('--all');

  for (const t of targets) {
    switch (t) {
      case '--all':
        await targetWebsite();
        await targetRelease();
        await targetNginx();
        break;
      case '--website':
        await targetWebsite();
        break;
      case '--release':
        await targetRelease();
        break;
      case '--nginx':
        await targetNginx();
        break;
      default:
        console.error(`未知参数: ${t}`);
        printUsage();
        process.exitCode = 1;
        return;
    }
  }

  console.log('🎉 部署完成');
}

main().catch((err) => {
  console.error('❌ 部署失败:', err.message);
  process.exit(1);
});
