import fs from 'fs';
import path from 'path';
import Module from 'module';
import { fileURLToPath, pathToFileURL } from 'url';
import cp from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Keep the snapshot beside this launcher. wolf.js runs the downloaded bot from
// a temporary directory, so anything stored inside that directory is deleted
// at shutdown. Pterodactyl keeps this directory across ordinary restarts.
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

// Seed persistence from files already present on the panel before wolf.js
// downloads and enters a clean source archive. Never replace a non-empty saved
// snapshot with repository defaults during startup.
if (!fs.existsSync(STORE)) {
  if (snapshot(__dirname)) log('created initial settings snapshot');
} else {
  // Put preserved .env/config files back beside the launcher as well. wolf.js
  // moves some of these files into its temporary runtime directory.
  restore(__dirname);
}

// npm installs initiated by the fetcher must not execute dependency lifecycle
// scripts. This also avoids incompatible Baileys postinstall checks on Node 25.
const originalSpawn = cp.spawn.bind(cp);
cp.spawn = function patchedSpawn(command, args, options) {
  if (
    (command === 'npm' || command === 'npm.cmd') &&
    Array.isArray(args) && args.includes('install') &&
    !args.includes('--ignore-scripts')
  ) {
    args = [...args, '--ignore-scripts'];
  }
  return originalSpawn(command, args, options);
};

let runtimeDir = null;
let snapshotBusy = false;
const originalChdir = process.chdir.bind(process);
process.chdir = function guardedChdir(directory) {
  const resolved = path.resolve(String(directory));
  originalChdir(resolved);
  runtimeDir = resolved;
  restore(resolved);
};

// Wrap the require function created by the obfuscated fetcher. Node versions
// used by Heroku can reject an ESM graph with top-level await before our
// Module._load fallback is reached, so detect the downloaded entry first and
// start that one file with import(). All other requires remain synchronous.
globalThis.__wolfCreateRequire = function wolfCreateRequire(filename) {
  const runtimeRequire = Module.createRequire(filename);

  function guardedRequire(request) {
    if (runtimeDir) {
      let resolved;
      try { resolved = runtimeRequire.resolve(request); }
      catch { return runtimeRequire(request); }

      const runtimeRoot = path.resolve(runtimeDir);
      const target = path.resolve(String(resolved));
      if (target === path.join(runtimeRoot, 'index.js')) {
        log('starting downloaded ESM bot with dynamic import');
        import(pathToFileURL(target).href).catch(importError => {
          console.error('[WOLF TECH] Failed to start downloaded bot:', importError);
          process.exitCode = 1;
        });
        return {};
      }
    }

    return runtimeRequire(request);
  }

  guardedRequire.resolve = runtimeRequire.resolve;
  guardedRequire.cache = runtimeRequire.cache;
  guardedRequire.extensions = runtimeRequire.extensions;
  guardedRequire.main = runtimeRequire.main;
  return guardedRequire;
};

// Recent wolfsocket releases contain top-level await. The obfuscated fetcher
// still starts the downloaded ESM entry with require(), which Node rejects with
// ERR_REQUIRE_ASYNC_MODULE. Fall back to import() only for that downloaded
// runtime entry; all ordinary CommonJS loading keeps its original behaviour.
const originalModuleLoad = Module._load;
Module._load = function guardedModuleLoad(request, parent, isMain) {
  try {
    return originalModuleLoad.call(this, request, parent, isMain);
  } catch (error) {
    if (error?.code !== 'ERR_REQUIRE_ASYNC_MODULE' || !runtimeDir) throw error;

    let resolved;
    try { resolved = Module._resolveFilename(request, parent, isMain); }
    catch { throw error; }

    const runtimeRoot = path.resolve(runtimeDir);
    const target = path.resolve(String(resolved));
    const isRuntimeEntry = target === path.join(runtimeRoot, 'index.js');
    if (!isRuntimeEntry) throw error;

    log('starting downloaded ESM bot with dynamic import');
    import(pathToFileURL(target).href).catch(importError => {
      console.error('[WOLF TECH] Failed to start downloaded bot:', importError);
      process.exitCode = 1;
    });
    return {};
  }
};

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

const wolfPath = path.join(__dirname, 'wolf.js');
if (!fs.existsSync(wolfPath)) {
  throw new Error(`wolf.js was not found at ${wolfPath}`);
}

// The published obfuscated fetcher passes an array to createRequire(). Patch
// only that invalid call and execute the resulting module beside this launcher.
const botSource = fs.readFileSync(wolfPath, 'utf8');
const patchedSource = botSource.replace(
  /createRequire\(\[([^\]]+)\]/g,
  'globalThis.__wolfCreateRequire(import.meta.url'
);
const temporaryLoader = path.join(__dirname, '.bot_run.js');
fs.writeFileSync(temporaryLoader, patchedSource);
await import(temporaryLoader);
