// Ad-hoc codesigns macOS builds so unsigned arm64 (and x64) apps launch
// without Gatekeeper killing the renderer (white-screen / SIGKILL).
// Also prunes wrong-platform lancedb prebuilt binaries — @lancedb ships
// every (os,arch) binary as a sibling package, and they all get installed
// into node_modules. Without this prune each build carries ~210MB of
// dead weight.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// electron-builder Arch enum: ia32=0, x64=1, armv7l=2, arm64=3, universal=4
const ARCH_NAMES = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' };

const LANCEDB_KEEP = {
  'darwin-arm64': 'lancedb-darwin-arm64',
  'darwin-x64':   'lancedb-darwin-x64',
  'linux-arm64':  'lancedb-linux-arm64-gnu',
  'linux-x64':    'lancedb-linux-x64-gnu',
  'win32-x64':    'lancedb-win32-x64-msvc',
};

function getResourcesDir(context) {
  const { electronPlatformName, appOutDir, packager } = context;
  if (electronPlatformName === 'darwin' || electronPlatformName === 'mas') {
    return path.join(appOutDir, `${packager.appInfo.productFilename}.app`, 'Contents', 'Resources');
  }
  return path.join(appOutDir, 'resources');
}

function pruneLanceDB(context) {
  const archStr = ARCH_NAMES[context.arch] || String(context.arch);
  const platformKey = `${context.electronPlatformName}-${archStr}`;
  const keep = LANCEDB_KEEP[platformKey];

  const lancedbDir = path.join(
    getResourcesDir(context),
    'app.asar.unpacked', 'node_modules', '@lancedb'
  );
  if (!fs.existsSync(lancedbDir)) return;

  for (const entry of fs.readdirSync(lancedbDir)) {
    if (entry === 'lancedb') continue;          // JS wrapper — always keep
    if (entry === keep) continue;               // active prebuilt — keep
    const full = path.join(lancedbDir, entry);
    console.log(`[after-pack] pruning ${full}`);
    fs.rmSync(full, { recursive: true, force: true });
  }
}

exports.default = async function afterPack(context) {
  pruneLanceDB(context);

  const { electronPlatformName, appOutDir, packager } = context;
  if (electronPlatformName !== 'darwin') return;

  const appName = packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);

  console.log(`[after-pack] cleaning detritus from ${appPath}`);
  try {
    // .DS_Store and ._* AppleDouble files trip up codesign
    execFileSync('find', [appPath, '-name', '.DS_Store', '-delete'], { stdio: 'inherit' });
    execFileSync('find', [appPath, '-name', '._*', '-delete'], { stdio: 'inherit' });
    execFileSync('xattr', ['-cr', appPath], { stdio: 'inherit' });
  } catch (err) {
    console.warn('[after-pack] cleanup failed:', err.message);
  }

  console.log(`[after-pack] ad-hoc signing ${appPath}`);
  try {
    execFileSync(
      'codesign',
      ['--force', '--deep', '--sign', '-', '--timestamp=none', appPath],
      { stdio: 'inherit' }
    );
  } catch (err) {
    console.warn('[after-pack] ad-hoc codesign failed:', err.message);
  }
};
