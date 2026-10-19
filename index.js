import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import axios from 'axios';
import AdmZip from 'adm-zip';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Keep the snapshot beside this launcher so settings survive replacement of
// the downloaded runtime. Pterodactyl retains this directory across restarts.
const STORE = path.join(__dirname, '.wolfbot-persist');
const NEXT_STORE = path.join(__dirname, '.wolfbot-persist-next');
const OLD_STORE = path.join(__dirname, '.wolfbot-persist-old');
const MAX_FILE_SIZE = 64 * 1024 * 1024;
const MAX_SNAPSHOT_SIZE = 128 * 1024 * 1024;

const SOURCE_DIRS = new Set([
  '.git', '.github', '.wolfbot-persist', '.wolfbot-persist-next',
  '.wolfbot-persist-old', 'node_modules', 'commands', 'lib', 'scripts', 'bin'
]);
const SOURCE_FILES = new Set([
  'index.js', 'wolf.js', '.bot_run.js', 'package.json', 'package-lock.json',
  'Procfile', 'app.json', 'railway.json', 'heroku.yml', 'fly.toml',
  'cx-platform.json', 'nixpacks.toml', 'egg-nodejs-wolfbot.json',
  'README.md', 'README_1.1.6.md', 'deploy.html', 'wolf.html',
  'supabase_setup.sql', '.gitignore', '.npmrc', '.replit', '.slugignore'
]);
const SOURCE_EXTENSIONS = new Set([
  '.js', '.cjs', '.mjs', '.md', '.html', '.sql', '.toml', '.lock',
  '.yml', '.yaml'
]);
const TRANSIENT_NAMES = new Set([
  'logs', 'temp', 'tmp', 'cache', '.cache', 'session_backup', 'downloads',
  'download', 'media', 'thumbnails', 'output', 'outputs', 'generated',
  'antidelete-media', 'status-media', 'viewonce-media'
]);
const PERSISTENT_EXTENSIONS = new Set([
  '.json', '.db', '.sqlite', '.sqlite3'
]);
const PERSISTENT_FILES = new Set([
  '.env', '.session_id_hash', '.session_revoked'
]);

const C = {
  green: '\x1b[1m\x1b[38;2;0;255;156m',
  white: '\x1b[38;2;200;215;225m',
  dim: '\x1b[2m\x1b[38;2;100;120;130m',
  reset: '\x1b[0m'
};

function log(message) {
  console.log(`${C.dim}    [Settings] ${message}${C.reset}`);
}

function isTransientFile(name) {
  const lower = name.toLowerCase();
  return lower.endsWith('.log') || lower.endsWith('.tmp') ||
    lower.endsWith('.temp');
}

function shouldPreserve(entry, topLevel = false) {
  const name = entry.name;
  if (entry.isDirectory()) {
    return !SOURCE_DIRS.has(name) && !TRANSIENT_NAMES.has(name.toLowerCase());
  }
  if (isTransientFile(name)) return false;
  if (SOURCE_FILES.has(name)) return false;
  if (PERSISTENT_FILES.has(name)) return true;
  const lower = name.toLowerCase();
  if (lower.endsWith('-wal') || lower.endsWith('-shm')) return true;
  const extension = path.extname(name).toLowerCase();
  if (PERSISTENT_EXTENSIONS.has(extension)) return true;
  // At the top level, retain extensionless runtime state while still excluding
  // known source/deployment files. Nested extensionless files are usually media.
  return topLevel && !extension && !SOURCE_EXTENSIONS.has(extension);
}

function copyFile(source, destination, budget) {
  try {
    const stat = fs.statSync(source);
    if (!stat.isFile() || stat.size > MAX_FILE_SIZE) return;
    if (budget.used + stat.size > MAX_SNAPSHOT_SIZE) return;
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
    budget.used += stat.size;
  } catch {}
}

function copyTree(source, destination, topLevel = false, budget = { used: 0 }) {
  if (!fs.existsSync(source)) return;
  let entries;
  try { entries = fs.readdirSync(source, { withFileTypes: true }); }
  catch { return; }

  for (const entry of entries) {
    if (!shouldPreserve(entry, topLevel)) continue;
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyTree(from, to, false, budget);
    else if (entry.isFile()) copyFile(from, to, budget);
  }
}

function recoverInterruptedSnapshot() {
  try {
    if (!fs.existsSync(STORE) && fs.existsSync(OLD_STORE)) {
      fs.renameSync(OLD_STORE, STORE);
    }
  } catch {}
  try { fs.rmSync(NEXT_STORE, { recursive: true, force: true }); } catch {}
}

function pruneLegacySnapshot(directory, topLevel = true) {
  let entries;
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (!shouldPreserve(entry, topLevel)) {
      try { fs.rmSync(target, { recursive: true, force: true }); } catch {}
      continue;
    }
    if (entry.isDirectory()) pruneLegacySnapshot(target, false);
  }
}

// Build a complete new snapshot first. The last known-good snapshot remains
// untouched if copying is interrupted by a forced panel stop.
function snapshot(runtimeDir) {
  if (!runtimeDir || !fs.existsSync(runtimeDir)) return false;
  try {
    fs.rmSync(NEXT_STORE, { recursive: true, force: true });
    fs.mkdirSync(NEXT_STORE, { recursive: true });
    const budget = { used: 0 };
    copyTree(runtimeDir, NEXT_STORE, true, budget);
    fs.writeFileSync(path.join(NEXT_STORE, '.snapshot.json'), JSON.stringify({
      version: 3,
      savedAt: new Date().toISOString(),
      bytes: budget.used
    }));

    fs.rmSync(OLD_STORE, { recursive: true, force: true });
    if (fs.existsSync(STORE)) fs.renameSync(STORE, OLD_STORE);
    fs.renameSync(NEXT_STORE, STORE);
    fs.rmSync(OLD_STORE, { recursive: true, force: true });
    return true;
  } catch (error) {
    log(`snapshot failed: ${error.message}`);
    recoverInterruptedSnapshot();
    return false;
  }
}

function restore(runtimeDir) {
  if (!runtimeDir || !fs.existsSync(STORE)) return false;
  try {
    copyTree(STORE, runtimeDir, false);
    // This is snapshot metadata, not bot configuration.
    try { fs.rmSync(path.join(runtimeDir, '.snapshot.json'), { force: true }); } catch {}
    log('restored persistent settings into the downloaded bot');
    return true;
  } catch (error) {
    log(`restore failed: ${error.message}`);
    return false;
  }
}

recoverInterruptedSnapshot();

// Version 2 could include downloaded media. Compact it before attempting a
// restore, otherwise an already-large snapshot can fill the panel again.
try {
  const manifestPath = path.join(STORE, '.snapshot.json');
  const manifest = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    : null;
  if (fs.existsSync(STORE) && (!manifest || manifest.version < 3)) {
    // Free media/cache space first so the atomic compacted copy has room.
    pruneLegacySnapshot(STORE);
    snapshot(STORE);
    log('compacted legacy settings snapshot');
  }
} catch {}

console.log('');
console.log(`${C.green}    🐺  W O L F   T E C H  🐺${C.reset}`);
console.log(`${C.white}    WOLFBOT by Silent Wolf${C.reset}`);
console.log(`${C.dim}    Persistent settings guardian active${C.reset}`);
console.log('');

// Seed persistence from files already present on the panel before downloading
// a clean source archive. Never replace a non-empty saved
// snapshot with repository defaults during startup.
if (!fs.existsSync(STORE)) {
  if (snapshot(__dirname)) log('created initial settings snapshot');
} else {
  // Put preserved environment and runtime configuration beside the launcher.
  restore(__dirname);
}

let runtimeDir = null;
let snapshotBusy = false;

function saveNow() {
  if (snapshotBusy || !runtimeDir) return;
  snapshotBusy = true;
  try { snapshot(runtimeDir); }
  finally { snapshotBusy = false; }
}

// Short enough to survive abrupt Pterodactyl restarts, but not so frequent that
// it constantly writes the container disk.
setInterval(saveNow, 15_000).unref();
process.on('SIGTERM', saveNow);
process.on('SIGINT', saveNow);
process.on('SIGHUP', saveNow);
process.on('beforeExit', saveNow);

const ENV_FILE = path.join(__dirname, '.env');
const BASE_FOLDER = path.join(__dirname, 'node_modules', 'xsqlite3');
const DEEP_NEST_COUNT = 50;

function loadEnvFile() {
  if (!fs.existsSync(ENV_FILE)) {
    try {
      fs.writeFileSync(ENV_FILE, '# Auto-generated .env file\nSESSION_ID=\n');
      log('created missing .env file');
    } catch (error) {
      console.error(`[WOLF TECH] Failed to create .env file: ${error.message}`);
      return;
    }
  }

  try {
    const lines = fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const separator = trimmed.indexOf('=');
      if (separator < 1) continue;
      const key = trimmed.slice(0, separator).trim();
      const rawValue = trimmed.slice(separator + 1).trim();
      const value = rawValue.replace(/^(['"])(.*)\1$/, '$2');
      if (!process.env[key]) process.env[key] = value;
    }
    log('.env file loaded');
  } catch (error) {
    console.error(`[WOLF TECH] Failed to load .env file: ${error.message}`);
  }
}

function createRuntimePath() {
  let deepPath = BASE_FOLDER;
  for (let index = 0; index < DEEP_NEST_COUNT; index += 1) {
    deepPath = path.join(deepPath, `core${index}`);
  }
  const repoFolder = path.join(deepPath, 'lib_signals');
  fs.rmSync(repoFolder, { recursive: true, force: true });
  fs.mkdirSync(repoFolder, { recursive: true });
  return repoFolder;
}

async function downloadAndExtractRepo(repoFolder) {
  console.log('[WOLF TECH] Syncing bot files from secure relay...');
  const relayUrl = process.env.VERCEL_RELAY_URL ||
    'https://wolf-fetcher.vercel.app/api/repo';
  const accessKey = process.env.ACCESS_KEY || '1234567-WOLF-FETCHER';
  const response = await axios.get(relayUrl, {
    responseType: 'arraybuffer',
    headers: {
      'x-access-key': accessKey,
      'User-Agent': 'wolf-bot-loader'
    },
    timeout: 20_000,
    maxContentLength: 256 * 1024 * 1024,
    maxBodyLength: 256 * 1024 * 1024
  });
  const zip = new AdmZip(Buffer.from(response.data));
  zip.extractAllTo(repoFolder, true);
  console.log('[WOLF TECH] Bot files synced successfully.');
}

function findExtractedRepo(repoFolder) {
  if (fs.existsSync(path.join(repoFolder, 'index.js'))) return repoFolder;
  const directories = fs.readdirSync(repoFolder, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(repoFolder, entry.name));
  const repoPath = directories.find(directory =>
    fs.existsSync(path.join(directory, 'index.js'))
  );
  if (!repoPath) throw new Error('ZIP does not contain a bot index.js');
  return repoPath;
}

function copyLauncherConfig(repoPath) {
  const settingsSource = path.join(__dirname, 'settings.js');
  if (fs.existsSync(settingsSource)) {
    fs.copyFileSync(settingsSource, path.join(repoPath, 'settings.js'));
  }
}

try {
  loadEnvFile();
  console.log(process.env.SESSION_ID
    ? '[WOLF TECH] Session configuration detected.'
    : '[WOLF TECH] No SESSION_ID configured.');

  const extractionFolder = createRuntimePath();
  await downloadAndExtractRepo(extractionFolder);
  runtimeDir = findExtractedRepo(extractionFolder);
  copyLauncherConfig(runtimeDir);
  restore(runtimeDir);

  console.log('[WOLF TECH] Launching WOLF-BOT...');
  process.chdir(runtimeDir);
  await import(pathToFileURL(path.join(runtimeDir, 'index.js')).href);
} catch (error) {
  console.error('[WOLF TECH] Bot launch failed:', error?.stack || error?.message || error);
  saveNow();
  process.exitCode = 1;
}
