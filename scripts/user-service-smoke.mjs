import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const platform = process.platform;
assert.ok(platform === 'darwin' || platform === 'linux', `unsupported platform: ${platform}`);
const readme = await readFile('README.md', 'utf8');
for (const requirement of [
  'com.better-tg-cli.mcp.plist',
  'launchctl bootstrap',
  'launchctl bootout',
  '<key>KeepAlive</key><true/>',
  'systemctl --user enable --now better-tg-cli-mcp.service',
  'Restart=on-failure',
  'loginctl enable-linger',
  'Keychain or Linux Secret Service',
]) {
  assert.ok(readme.includes(requirement), `README user-service recipe is missing: ${requirement}`);
}

const env = { ...process.env, TG_PROFILE: 'user-service-smoke', TG_NO_UPDATE_CHECK: '1' };
const home = homedir();
const label = 'com.better-tg-cli.mcp';
const unitName = 'better-tg-cli-mcp.service';
const port = 8787;
const baseUrl = `http://127.0.0.1:${port}/mcp`;
const nodeBin = process.execPath;
const telegramBin = execFileSync('which', ['telegram'], { encoding: 'utf8' }).trim();
assert.ok(telegramBin && existsSync(telegramBin), 'globally installed telegram executable not found');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env,
    timeout: options.timeout ?? 30_000,
    maxBuffer: 1_000_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || (result.status !== 0 && !options.allowFailure)) {
    const reason = result.error ? 'spawn error' : `exit ${result.status}`;
    throw new Error(`${command} ${args[0] ?? ''} failed (${reason})`);
  }
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
}

function platformVersion() {
  if (platform === 'darwin') return run('sw_vers', ['-productVersion']).stdout.trim();
  return run('bash', ['-lc', '. /etc/os-release; printf "%s" "$PRETTY_NAME"']).stdout.trim();
}

function secretStoreDelete() {
  if (platform === 'darwin') {
    run('/usr/bin/security', ['delete-generic-password', '-s', 'tg-cli-user-service-smoke', '-a', 'mcpToken'], { allowFailure: true });
  } else {
    run('secret-tool', ['clear', 'service', 'tg-cli-user-service-smoke', 'account', 'mcpToken'], { allowFailure: true });
  }
}

function getToken() {
  const result = spawnSync(nodeBin, [telegramBin, 'mcp', '--token'], {
    encoding: 'utf8', env, timeout: 20_000, maxBuffer: 16_384,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) throw new Error('CLI could not initialize its OS secret-store token');
  const token = (result.stdout ?? '').trim();
  assert.match(token, /^tgmcp_[A-Za-z0-9_-]+$/, 'CLI did not return the expected token shape');
  return token;
}

async function request(token, authenticated) {
  return fetch(baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authenticated ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    signal: AbortSignal.timeout(2_000),
  });
}

async function waitFor(check, description, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`${description} did not become ready${lastError ? ` (${lastError.name})` : ''}`);
}

async function assertEndpoint(token) {
  const unauthorized = await request(token, false);
  assert.equal(unauthorized.status, 401, 'service must reject missing bearer token');
  const response = await request(token, true);
  assert.equal(response.status, 200, 'service must accept its OS-stored bearer token');
  const body = await response.json();
  assert.deepEqual(body.result.tools.map(tool => tool.name), ['telegram_help', 'telegram_read']);
}

function parsePid(text) {
  const match = text.match(/^\s*pid\s*=\s*(\d+)\s*$/m);
  return match ? Number(match[1]) : null;
}

let loaded = false;
let token;
let serviceFile;
let logPaths = [];
let lingerWasEnabled = false;

try {
  token = getToken();
  if (platform === 'darwin') {
    const logs = join(home, 'Library', 'Logs');
    const agents = join(home, 'Library', 'LaunchAgents');
    serviceFile = join(agents, `${label}.plist`);
    logPaths = [join(logs, 'better-tg-cli-mcp.log'), join(logs, 'better-tg-cli-mcp.error.log')];
    await mkdir(agents, { recursive: true });
    await mkdir(logs, { recursive: true });
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array><string>${nodeBin}</string><string>${telegramBin}</string><string>mcp</string><string>--http</string><string>--read-only</string></array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>EnvironmentVariables</key><dict><key>TG_NO_UPDATE_CHECK</key><string>1</string><key>TG_PROFILE</key><string>user-service-smoke</string></dict>
  <key>StandardOutPath</key><string>${logPaths[0]}</string>
  <key>StandardErrorPath</key><string>${logPaths[1]}</string>
</dict></plist>`;
    await writeFile(serviceFile, plist, { mode: 0o600 });
    run('plutil', ['-lint', serviceFile]);
    const uid = run('id', ['-u']).stdout.trim();
    const domain = `gui/${uid}`;
    run('launchctl', ['bootstrap', domain, serviceFile]);
    loaded = true;
    const serviceTarget = `${domain}/${label}`;
    const first = await waitFor(async () => {
      await assertEndpoint(token);
      return parsePid(run('launchctl', ['print', serviceTarget]).stdout);
    }, 'launchd service startup');
    for (const path of logPaths) await waitFor(() => existsSync(path), `launchd log ${path}`);
    const logsBefore = (await Promise.all(logPaths.map(path => readFile(path, 'utf8').catch(() => '')))).join('\n');
    assert.match(logsBefore, /MCP over HTTP on http:\/\/127\.0\.0\.1:8787\/mcp/);
    assert.ok(!logsBefore.includes(token), 'bearer token leaked to launchd logs');
    process.kill(first, 'SIGKILL');
    const restarted = await waitFor(async () => {
      const current = parsePid(run('launchctl', ['print', serviceTarget]).stdout);
      if (!current || current === first) return false;
      await assertEndpoint(token);
      return current;
    }, 'launchd KeepAlive restart');
    run('launchctl', ['bootout', domain, serviceFile]);
    loaded = false;
    await waitFor(async () => {
      try { await request(token, true); return false; } catch { return true; }
    }, 'launchd bootout');
    const logsAfter = (await Promise.all(logPaths.map(path => readFile(path, 'utf8').catch(() => '')))).join('\n');
    assert.ok(logsAfter.length > 0, 'launchd stdout/stderr logs were not retained');
    assert.ok(!logsAfter.includes(token), 'bearer token leaked after launchd restart');
    console.log(`PASS manager=launchd os=macOS ${platformVersion()} runner=GitHub-hosted VM bootstrap=PASS keepalive_restart=PASS bootout=PASS logs=PASS pid_changed=${first !== restarted}`);
  } else {
    const uid = run('id', ['-u']).stdout.trim();
    const username = run('id', ['-un']).stdout.trim();
    const linger = run('loginctl', ['show-user', username, '-p', 'Linger', '--value'], { allowFailure: true }).stdout.trim();
    lingerWasEnabled = linger === 'yes';
    run('sudo', ['-n', 'loginctl', 'enable-linger', username]);
    assert.equal(run('loginctl', ['show-user', username, '-p', 'Linger', '--value']).stdout.trim(), 'yes');
    run('sudo', ['-n', 'systemctl', 'start', `user@${uid}.service`]);
    const runtime = `/run/user/${uid}`;
    env.XDG_RUNTIME_DIR = runtime;
    env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${runtime}/bus`;
    assert.ok(existsSync(join(runtime, 'bus')), 'systemd user D-Bus is not available on this runner');
    serviceFile = join(home, '.config', 'systemd', 'user', unitName);
    await mkdir(join(home, '.config', 'systemd', 'user'), { recursive: true });
    const unit = `[Unit]\nDescription=better-tg-cli MCP over HTTP smoke test\nAfter=default.target\n\n[Service]\nExecStart="${nodeBin}" "${telegramBin}" mcp --http --read-only\nRestart=on-failure\nRestartSec=3\nEnvironment=TG_NO_UPDATE_CHECK=1\nEnvironment=TG_PROFILE=user-service-smoke\n\n[Install]\nWantedBy=default.target\n`;
    await writeFile(serviceFile, unit, { mode: 0o600 });
    run('systemctl', ['--user', 'daemon-reload']);
    run('systemctl', ['--user', 'enable', '--now', unitName]);
    loaded = true;
    const first = await waitFor(async () => {
      await assertEndpoint(token);
      const pid = Number(run('systemctl', ['--user', 'show', unitName, '-p', 'MainPID', '--value']).stdout.trim());
      return pid > 0 ? pid : false;
    }, 'systemd user service startup');
    const journal = () => run('journalctl', ['--user', '-u', unitName, '--no-pager', '-o', 'cat'], { allowFailure: true }).stdout;
    await waitFor(() => journal().includes('MCP over HTTP on http://127.0.0.1:8787/mcp'), 'systemd journal output');
    assert.ok(!journal().includes(token), 'bearer token leaked to systemd journal');
    run('systemctl', ['--user', 'restart', unitName]);
    const manuallyRestarted = await waitFor(async () => {
      const pid = Number(run('systemctl', ['--user', 'show', unitName, '-p', 'MainPID', '--value']).stdout.trim());
      if (pid <= 0 || pid === first) return false;
      await assertEndpoint(token);
      return pid;
    }, 'systemctl --user restart');
    process.kill(manuallyRestarted, 'SIGKILL');
    const automaticallyRestarted = await waitFor(async () => {
      const pid = Number(run('systemctl', ['--user', 'show', unitName, '-p', 'MainPID', '--value']).stdout.trim());
      if (pid <= 0 || pid === manuallyRestarted) return false;
      await assertEndpoint(token);
      return pid;
    }, 'systemd Restart=on-failure');
    assert.ok(!journal().includes(token), 'bearer token leaked after systemd restart');
    run('systemctl', ['--user', 'disable', '--now', unitName]);
    loaded = false;
    run('systemctl', ['--user', 'daemon-reload']);
    await waitFor(async () => {
      try { await request(token, true); return false; } catch { return true; }
    }, 'systemd service stop');
    console.log(`PASS manager=systemd-user os=${platformVersion()} runner=GitHub-hosted VM loginctl_linger=PASS manual_restart=PASS on_failure_restart=PASS journal=PASS stopped=PASS pid_changes=${first !== manuallyRestarted && manuallyRestarted !== automaticallyRestarted}`);
  }
} finally {
  if (platform === 'darwin' && loaded && serviceFile) {
    run('launchctl', ['bootout', `gui/${run('id', ['-u']).stdout.trim()}`, serviceFile], { allowFailure: true });
  }
  if (platform === 'linux') {
    if (loaded) run('systemctl', ['--user', 'disable', '--now', unitName], { allowFailure: true });
    if (serviceFile) {
      await rm(serviceFile, { force: true });
      run('systemctl', ['--user', 'daemon-reload'], { allowFailure: true });
    }
    if (!lingerWasEnabled) {
      const username = run('id', ['-un']).stdout.trim();
      run('sudo', ['-n', 'loginctl', 'disable-linger', username], { allowFailure: true });
    }
  }
  if (serviceFile) await rm(serviceFile, { force: true });
  secretStoreDelete();
}
