#!/usr/bin/env node
const http = require('http');
const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');

// Async exec helper
function execAsync(cmd, timeout = 15000) {
  return new Promise((resolve, reject) => {
    exec(cmd, { encoding: 'utf8', timeout }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

const PORT = process.env.STATUS_PORT || 60601;
const SETTINGS_FILE = path.join(__dirname, '.panel-settings.json');
const DEFAULT_OC_PATH = path.join(process.env.HOME || '/root', '.openclaw');

function getOcPath() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      if (s.ocPath && fs.existsSync(s.ocPath)) return s.ocPath;
    }
  } catch {}
  // Fallback to default OpenClaw home directory
  return DEFAULT_OC_PATH;
}

// ─── Status Collection ───────────────────────────────────────────

function collectStatus(callback) {
  const status = { timestamp: new Date().toISOString() };

  // Run expensive shell commands async, read /proc sync (fast)
  let pending = 4;
  const done = () => { if (--pending <= 0) callback(status); };

  // /proc reads (instant)
  try {
    const cpuModel = fs.readFileSync('/proc/cpuinfo', 'utf8').match(/model name\s*:\s*(.+)/)?.[1]?.trim() || 'Unknown';
    const cpuCores = parseInt(fs.readFileSync('/proc/cpuinfo', 'utf8').match(/processor\s*:/g)?.length) || 0;
    status.cpu = { model: cpuModel, cores: cpuCores };
  } catch { status.cpu = { model: 'Unknown', cores: 0 }; }

  try {
    const loadavg = fs.readFileSync('/proc/loadavg', 'utf8').trim().split(' ');
    status.load = { '1m': parseFloat(loadavg[0]), '5m': parseFloat(loadavg[1]), '15m': parseFloat(loadavg[2]) };
  } catch { status.load = null; }

  try {
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
    const get = (key) => { const m = meminfo.match(new RegExp(`${key}:\\s+(\\d+)`)); return m ? parseInt(m[1]) * 1024 : 0; };
    const total = get('MemTotal'), avail = get('MemAvailable'), buffers = get('Buffers'), cached = get('Cached');
    const used = total - avail;
    status.memory = { total, used, available: avail, buffers, cached, usedPercent: Math.round((used / total) * 100) };
  } catch { status.memory = null; }

  try {
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
    const get = (key) => { const m = meminfo.match(new RegExp(`${key}:\\s+(\\d+)`)); return m ? parseInt(m[1]) * 1024 : 0; };
    status.swap = { total: get('SwapTotal'), free: get('SwapFree') };
  } catch { status.swap = null; }

  try {
    const uptimeSec = parseFloat(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
    const days = Math.floor(uptimeSec / 86400);
    const hours = Math.floor((uptimeSec % 86400) / 3600);
    const mins = Math.floor((uptimeSec % 3600) / 60);
    status.uptime = { seconds: uptimeSec, formatted: `${days}d ${hours}h ${mins}m` };
  } catch { status.uptime = null; }

  // Async shell commands
  exec("df -B1 / | tail -1", { encoding: 'utf8', timeout: 5000 }, (err, out) => {
    if (!err) {
      const df = out.trim().split(/\s+/);
      status.disk = { total: parseInt(df[1]), used: parseInt(df[2]), available: parseInt(df[3]), usedPercent: parseInt(df[4]), mount: df[5] };
    }
    done();
  });

  exec("uname -srmo && hostname", { encoding: 'utf8', timeout: 5000 }, (err, out) => {
    if (!err) {
      const lines = out.trim().split('\n');
      status.os = { kernel: lines[0] || '', hostname: lines[1] || '' };
    }
    done();
  });

  exec("ps aux | grep -E 'openclaw-gateway|openclaw' | grep -v grep", { encoding: 'utf8', timeout: 5000 }, (err, out) => {
    if (!err && out.trim()) {
      const lines = out.trim().split('\n').filter(Boolean);
      const gwProc = lines.find(l => l.includes('openclaw-gateway'));
      const mainProc = lines.find(l => !l.includes('gateway') && l.includes('openclaw'));
      const parsePid = (line) => line ? line.trim().split(/\s+/)[1] : null;
      status.gateway = { status: gwProc ? 'running' : 'inactive', gatewayPid: parsePid(gwProc), mainPid: parsePid(mainProc), processes: lines.length };
    } else {
      status.gateway = { status: 'not detected' };
    }
    done();
  });

  exec("ss -tun state established | wc -l && ps aux --sort=-%cpu | head -6 | tail -5", { encoding: 'utf8', timeout: 5000 }, (err, out) => {
    if (!err) {
      const lines = out.trim().split('\n');
      status.network = { establishedConnections: parseInt(lines[0]) - 1 };
      status.topProcesses = lines.slice(1).map(line => {
        const parts = line.trim().split(/\s+/);
        return { user: parts[0], pid: parts[1], cpu: parts[2], mem: parts[3], command: parts.slice(10).join(' ') };
      });
    }
    done();
  });

  // Sessions (fast file read)
  try {
    const sessionsFile = path.join(getOcPath(), 'agents/main/sessions/sessions.json');
    if (fs.existsSync(sessionsFile)) {
      const sessions = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
      const sessionList = Array.isArray(sessions) ? sessions : Object.values(sessions);
      status.sessions = { total: sessionList.length, list: sessionList.slice(0, 10).map(s => ({ id: s.sessionKey || s.id || 'unknown', model: s.model || 'unknown', lastActive: s.lastActiveAt || s.updatedAt || null })) };
    } else { status.sessions = { total: 0, list: [] }; }
  } catch { status.sessions = { total: 0, list: [] }; }
}

// ─── HTTP Server ─────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  // API
  if (req.url === '/api/status') {
    collectStatus((status) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify(status));
    });
    return;
  }

  // Gateway info (port, token, visitor IP)
  if (req.url === '/api/gateway-info') {
    let info = { port: 18789, token: '', panelUrl: '' };
    try {
      const cfgPath = path.join(getOcPath(), 'openclaw.json');
      if (fs.existsSync(cfgPath)) {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        info.port = cfg.gateway?.port || 18789;
        info.token = cfg.gateway?.auth?.token || '';
      }
    } catch {}
    const visitorIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
      || req.socket.remoteAddress?.replace('::ffff:', '')
      || '';
    info.visitorIp = visitorIp;
    // 获取本机所有局域网 IP
    try {
      const ifaces = execSync("hostname -I 2>/dev/null || ip -4 addr show | grep -oP '(?<=inet\\s)\\d+(\\.\\d+){3}'", { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean);
      info.hostIps = ifaces;
      const base = `http://${ifaces[0] || 'localhost'}:${info.port}`;
      info.panelUrl = info.token ? `${base}?token=${encodeURIComponent(info.token)}` : base;
    } catch {
      info.hostIps = [];
      const base = `http://localhost:${info.port}`;
      info.panelUrl = info.token ? `${base}?token=${encodeURIComponent(info.token)}` : base;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(info));
    return;
  }

  // Clear memory cache
  if (req.url === '/api/clear-cache' && req.method === 'POST') {
    try {
      execSync('sync && echo 3 > /proc/sys/vm/drop_caches', { encoding: 'utf8' });
      // Re-collect memory info directly from /proc
      const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
      const get = (key) => { const m = meminfo.match(new RegExp(`${key}:\\s+(\\d+)`)); return m ? parseInt(m[1]) * 1024 : 0; };
      const total = get('MemTotal'), avail = get('MemAvailable'), buffers = get('Buffers'), cached = get('Cached');
      const used = total - avail;
      const memory = { total, used, available: avail, buffers, cached, usedPercent: Math.round((used / total) * 100) };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, memory, message: '缓存已清理' }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: '清理失败，需要 root 权限: ' + e.message }));
    }
    return;
  }

  // ─── OpenClaw Gateway Control ───────────────────────────────

  // Gateway restart
  if (req.url === '/api/gateway/restart' && req.method === 'POST') {
    try {
      const out = execSync('openclaw gateway restart 2>&1', { encoding: 'utf8', timeout: 30000 });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message: '网关已重启', output: out.trim() }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: '重启失败: ' + (e.stderr || e.message) }));
    }
    return;
  }

  // Gateway stop
  if (req.url === '/api/gateway/stop' && req.method === 'POST') {
    try {
      const out = execSync('openclaw gateway stop 2>&1', { encoding: 'utf8', timeout: 15000 });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message: '网关已停止', output: out.trim() }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: '停止失败: ' + (e.stderr || e.message) }));
    }
    return;
  }

  // Gateway start
  if (req.url === '/api/gateway/start' && req.method === 'POST') {
    try {
      const out = execSync('openclaw gateway start 2>&1', { encoding: 'utf8', timeout: 15000 });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message: '网关已启动', output: out.trim() }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: '启动失败: ' + (e.stderr || e.message) }));
    }
    return;
  }

  // List models — reads from models.providers structure
  if (req.url === '/api/models' && req.method === 'GET') {
    try {
      const configPath = path.join(getOcPath(), 'openclaw.json');
      let models = [];
      let currentModel = '';
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        // Read current model from agents.defaults.model.primary or model
        currentModel = config.agents?.defaults?.model?.primary || config.model || '';
        // Read models from models.providers
        const providers = config.models?.providers || {};
        for (const [provName, prov] of Object.entries(providers)) {
          if (prov.models && Array.isArray(prov.models)) {
            for (const m of prov.models) {
              const fullId = provName + '/' + m.id;
              models.push({
                id: fullId,
                name: m.name || m.id,
                provider: provName,
              });
            }
          }
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, models, currentModel }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: '获取模型列表失败: ' + e.message }));
    }
    return;
  }

  // Switch model — updates agents.defaults.model.primary
  if (req.url === '/api/models/switch' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { modelId } = JSON.parse(body);
        if (!modelId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: '缺少 modelId' }));
          return;
        }
        const configPath = path.join(getOcPath(), 'openclaw.json');
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (!config.agents) config.agents = {};
        if (!config.agents.defaults) config.agents.defaults = {};
        if (!config.agents.defaults.model) config.agents.defaults.model = {};
        config.agents.defaults.model.primary = modelId;
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, message: `已切换到 ${modelId}` }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '切换失败: ' + e.message }));
      }
    });
    return;
  }

  // Add model — adds to models.providers
  if (req.url === '/api/models/add' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { id, name, provider, apiKey, baseUrl } = JSON.parse(body);
        if (!id || !provider) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: '缺少必要字段: id, provider' }));
          return;
        }
        const configPath = path.join(getOcPath(), 'openclaw.json');
        if (!fs.existsSync(configPath)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: '配置文件不存在' }));
          return;
        }
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (!config.models) config.models = { providers: {} };
        if (!config.models.providers) config.models.providers = {};
        // Create provider if not exists
        if (!config.models.providers[provider]) {
          config.models.providers[provider] = { models: [] };
          if (baseUrl) config.models.providers[provider].baseUrl = baseUrl;
          if (apiKey) config.models.providers[provider].apiKey = apiKey;
        }
        // Check if model already exists
        const provModels = config.models.providers[provider].models || [];
        if (provModels.find(m => m.id === id)) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: `模型 ${provider}/${id} 已存在` }));
          return;
        }
        provModels.push({ id, name: name || id, input: ['text'] });
        config.models.providers[provider].models = provModels;
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, message: `模型 ${provider}/${id} 已添加`, model: { id: provider + '/' + id, name: name || id, provider } }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '添加失败: ' + e.message }));
      }
    });
    return;
  }

  // Delete model — removes from models.providers
  if (req.url.startsWith('/api/models/delete') && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { modelId } = JSON.parse(body);
        if (!modelId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: '缺少 modelId' }));
          return;
        }
        // modelId format: provider/model
        const slashIdx = modelId.indexOf('/');
        const provider = slashIdx > 0 ? modelId.substring(0, slashIdx) : '';
        const modelShortId = slashIdx > 0 ? modelId.substring(slashIdx + 1) : modelId;
        if (!provider) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: '模型 ID 格式应为 provider/model' }));
          return;
        }
        const configPath = path.join(getOcPath(), 'openclaw.json');
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const prov = config.models?.providers?.[provider];
        if (!prov || !prov.models) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: `模型 ${modelId} 不存在` }));
          return;
        }
        const idx = prov.models.findIndex(m => m.id === modelShortId);
        if (idx === -1) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: `模型 ${modelId} 不存在` }));
          return;
        }
        prov.models.splice(idx, 1);
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, message: `模型 ${modelId} 已删除` }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '删除失败: ' + e.message }));
      }
    });
    return;
  }

  // Settings info
  if (req.url === '/api/settings' && req.method === 'GET') {
    const ocPath = getOcPath();
    let version = '—';
    try { version = execSync('openclaw --version 2>/dev/null', { encoding: 'utf8', timeout: 5000 }).trim(); } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ocPath, cfgPath: ocPath + '/openclaw.json', port: PORT, version }));
    return;
  }

  // Update settings path
  if (req.url === '/api/settings/path' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { ocPath } = JSON.parse(body);
        if (!ocPath) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: '路径不能为空' }));
          return;
        }
        // Save to a local settings file
        const settingsFile = path.join(__dirname, '.panel-settings.json');
        fs.writeFileSync(settingsFile, JSON.stringify({ ocPath }, null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ocPath }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '保存失败: ' + e.message }));
      }
    });
    return;
  }

  // Channels info
  if (req.url === '/api/channels' && req.method === 'GET') {
    const supported = [
      { id: 'telegram', name: 'Telegram', icon: '✈️', docs: 'https://docs.openclaw.ai/channels/telegram' },
      { id: 'discord', name: 'Discord', icon: '🎮', docs: 'https://docs.openclaw.ai/channels/discord' },
      { id: 'whatsapp', name: 'WhatsApp', icon: '💬', docs: 'https://docs.openclaw.ai/channels/whatsapp' },
      { id: 'signal', name: 'Signal', icon: '🔒', docs: 'https://docs.openclaw.ai/channels/signal' },
      { id: 'slack', name: 'Slack', icon: '💼', docs: 'https://docs.openclaw.ai/channels/slack' },
      { id: 'wechat', name: '微信', icon: '💚', docs: 'https://github.com/icesword0760/openclaw-wechat', install: 'openclaw plugins install @icesword760/openclaw-wechat' },
      { id: 'feishu', name: '飞书', icon: '🐦', docs: 'https://docs.openclaw.ai/channels/feishu' },
      { id: 'imessage', name: 'iMessage', icon: '🍎', docs: 'https://docs.openclaw.ai/channels/imessage' },
      { id: 'line', name: 'LINE', icon: '💚', docs: 'https://docs.openclaw.ai/channels/line' },
      { id: 'irc', name: 'IRC', icon: '📡', docs: 'https://docs.openclaw.ai/channels/irc' },
      { id: 'matrix', name: 'Matrix', icon: '🟩', docs: 'https://docs.openclaw.ai/channels/matrix' },
      { id: 'googlechat', name: 'Google Chat', icon: '💬', docs: 'https://docs.openclaw.ai/channels/googlechat' },
      { id: 'mattermost', name: 'Mattermost', icon: '🟣', docs: 'https://docs.openclaw.ai/channels/mattermost' },
      { id: 'msteams', name: 'MS Teams', icon: '🟦', docs: 'https://docs.openclaw.ai/channels/msteams' },
      { id: 'twitch', name: 'Twitch', icon: '🟪', docs: 'https://docs.openclaw.ai/channels/twitch' },
      { id: 'zalo', name: 'Zalo', icon: '🔵', docs: 'https://docs.openclaw.ai/channels/zalo' },
      { id: 'nostr', name: 'Nostr', icon: '🟧', docs: 'https://docs.openclaw.ai/channels/nostr' },
      { id: 'bluebubbles', name: 'BlueBubbles', icon: '🔵', docs: 'https://docs.openclaw.ai/channels/bluebubbles' },
      { id: 'synology-chat', name: 'Synology Chat', icon: '🟢', docs: 'https://docs.openclaw.ai/channels/synology-chat' },
      { id: 'nextcloud-talk', name: 'Nextcloud Talk', icon: '☁️', docs: 'https://docs.openclaw.ai/channels/nextcloud-talk' },
    ];
    // Detect connected channels from config
    let connected = [];
    try {
      const cfgPath = path.join(getOcPath(), 'openclaw.json');
      if (fs.existsSync(cfgPath)) {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        const channels = cfg.channels || {};
        for (const [id, ch] of Object.entries(channels)) {
          if (ch && typeof ch === 'object' && Object.keys(ch).length > 0) {
            const match = supported.find(s => s.id === id);
            connected.push({
              id,
              name: match?.name || id,
              icon: match?.icon || '📡',
              enabled: ch.enabled !== false,
            });
          }
        }
      }
    } catch {}
    // Detect installed community plugins (extensions directory)
    try {
      const extDir = path.join(getOcPath(), 'extensions');
      if (fs.existsSync(extDir)) {
        const entries = fs.readdirSync(extDir);
        for (const entry of entries) {
          const match = supported.find(s => s.id === entry || entry.includes(s.id));
          if (match && !connected.find(c => c.id === match.id)) {
            connected.push({ id: match.id, name: match.name, icon: match.icon, enabled: true });
          }
        }
      }
    } catch {}
    // Also try channels list command
    try {
      const out = execSync('openclaw channels list --json 2>/dev/null', { encoding: 'utf8', timeout: 10000 });
      const data = JSON.parse(out);
      // Handle both array and object formats
      const chatChannels = Array.isArray(data) ? data : (data.chat ? Object.entries(data.chat).map(([id, ch]) => ({ id, ...ch })) : []);
      for (const ch of chatChannels) {
        if (!connected.find(c => c.id === ch.id)) {
          connected.push({ id: ch.id, name: ch.name || ch.id, icon: '📡', enabled: true });
        }
      }
    } catch {}
    const connectedIds = new Set(connected.map(c => c.id));
    const available = supported.filter(s => !connectedIds.has(s.id));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, connected, available }));
    return;
  }

  // Usage / token consumption
  if ((req.url === '/api/usage' || req.url.startsWith('/api/usage?')) && req.method === 'GET') {
    // Parse optional date parameter: /api/usage?date=2026-04-10
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const queryDate = urlObj.searchParams.get('date');
    const today = new Date().toISOString().slice(0, 10);
    const targetDate = queryDate || today;
    const isToday = targetDate === today;

    // Run both queries in parallel
    Promise.all([
      // Current session data (always fresh)
      execAsync('openclaw status --usage --json 2>/dev/null', 20000).catch(() => null),
      // Daily cost report for selected date
      new Promise((resolve) => {
        exec(`START_DATE="${targetDate}" END_DATE="${targetDate}" bash ${path.join(process.env.HOME || '/root', '.openclaw/skills/cost-report/scripts/cost_report.sh')} --format json 2>/dev/null`, { encoding: 'utf8', timeout: 15000 }, (err, stdout) => {
          try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
        });
      })
    ]).then(([statusOut, costOut]) => {
      let sessions = [];
      let providerUsage = [];
      let update = null;

      if (statusOut) {
        try {
          const data = JSON.parse(statusOut);
          sessions = (data.sessions?.recent || []).map(s => ({
            key: s.key,
            model: s.model,
            inputTokens: s.inputTokens || 0,
            outputTokens: s.outputTokens || 0,
            cacheRead: s.cacheRead || 0,
            cacheWrite: s.cacheWrite || 0,
            totalTokens: s.totalTokens || 0,
            contextTokens: s.contextTokens || 0,
            remainingTokens: s.remainingTokens || 0,
            percentUsed: s.percentUsed || 0,
          }));
          providerUsage = (data.usage?.providers || []).map(p => ({
            provider: p.provider,
            displayName: p.displayName,
            windows: p.windows || [],
          }));
          update = data.update || null;
        } catch {}
      }

      const usage = {
        ok: true,
        date: targetDate,
        isToday,
        sessions: isToday ? sessions : [],
        dailyTokens: costOut?.totalTokens || (isToday ? (sessions[0]?.totalTokens || 0) : 0),
        dailyCost: costOut?.total || 0,
        dailyModels: costOut?.models || [],
        dailyErrors: costOut?.errors || [],
        providerUsage,
        update,
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(usage));
    }).catch(e => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: '获取使用数据失败: ' + e.message }));
    });
    return;
  }

  // Serve HTML pages
  let filePath;
  if (req.url === '/' || req.url === '/index.html') {
    filePath = path.join(__dirname, 'index.html');
  } else {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }

  try {
    const html = fs.readFileSync(filePath, 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch {
    res.writeHead(404);
    res.end('Page not found');
  }
});

// ─── Error Protection ─────────────────────────────────────

server.on('error', (err) => {
  console.error('Server error:', err.message);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err.message, err.stack?.split('\n').slice(0, 3).join('\n'));
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err?.message || err);
});

// ─── Start ───────────────────────────────────────────────────────

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🖥️  OpenClaw 状态面板: http://localhost:${PORT}`);
  console.log(`📊 API:              http://localhost:${PORT}/api/status`);
});
