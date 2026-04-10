#!/usr/bin/env node
const http = require('http');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = process.env.STATUS_PORT || 60601;

// ─── Status Collection ───────────────────────────────────────────

function collectStatus() {
  const status = { timestamp: new Date().toISOString() };

  try {
    const cpuModel = execSync("grep 'model name' /proc/cpuinfo | head -1 | cut -d: -f2", { encoding: 'utf8' }).trim();
    const cpuCores = execSync('nproc', { encoding: 'utf8' }).trim();
    status.cpu = { model: cpuModel, cores: parseInt(cpuCores) };
  } catch { status.cpu = { model: 'Unknown', cores: 0 }; }

  try {
    const loadavg = fs.readFileSync('/proc/loadavg', 'utf8').trim().split(' ');
    status.load = { '1m': parseFloat(loadavg[0]), '5m': parseFloat(loadavg[1]), '15m': parseFloat(loadavg[2]) };
  } catch { status.load = null; }

  try {
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
    const get = (key) => {
      const m = meminfo.match(new RegExp(`${key}:\\s+(\\d+)`));
      return m ? parseInt(m[1]) * 1024 : 0;
    };
    const total = get('MemTotal'), avail = get('MemAvailable'), buffers = get('Buffers'), cached = get('Cached');
    const used = total - avail;
    status.memory = { total, used, available: avail, buffers, cached, usedPercent: Math.round((used / total) * 100) };
  } catch { status.memory = null; }

  try {
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
    const get = (key) => {
      const m = meminfo.match(new RegExp(`${key}:\\s+(\\d+)`));
      return m ? parseInt(m[1]) * 1024 : 0;
    };
    status.swap = { total: get('SwapTotal'), free: get('SwapFree') };
  } catch { status.swap = null; }

  try {
    const df = execSync("df -B1 / | tail -1", { encoding: 'utf8' }).trim().split(/\s+/);
    status.disk = { total: parseInt(df[1]), used: parseInt(df[2]), available: parseInt(df[3]), usedPercent: parseInt(df[4]), mount: df[5] };
  } catch { status.disk = null; }

  try {
    const uptimeSec = parseFloat(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
    const days = Math.floor(uptimeSec / 86400);
    const hours = Math.floor((uptimeSec % 86400) / 3600);
    const mins = Math.floor((uptimeSec % 3600) / 60);
    status.uptime = { seconds: uptimeSec, formatted: `${days}d ${hours}h ${mins}m` };
  } catch { status.uptime = null; }

  try {
    const os = execSync("uname -srmo", { encoding: 'utf8' }).trim();
    const hostname = execSync("hostname", { encoding: 'utf8' }).trim();
    status.os = { kernel: os, hostname };
  } catch { status.os = null; }

  try {
    const psOut = execSync("ps aux | grep -E 'openclaw-gateway|openclaw' | grep -v grep", { encoding: 'utf8' }).trim();
    const lines = psOut.split('\n').filter(Boolean);
    const gwProc = lines.find(l => l.includes('openclaw-gateway'));
    const mainProc = lines.find(l => !l.includes('gateway') && l.includes('openclaw'));
    const parsePid = (line) => line ? line.trim().split(/\s+/)[1] : null;
    status.gateway = {
      status: gwProc ? 'running' : 'inactive',
      gatewayPid: parsePid(gwProc),
      mainPid: parsePid(mainProc),
      processes: lines.length
    };
  } catch { status.gateway = { status: 'not detected' }; }

  try {
    const sessionsFile = path.join(process.env.HOME || '/root', '.openclaw/agents/main/sessions/sessions.json');
    if (fs.existsSync(sessionsFile)) {
      const sessions = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
      const sessionList = Array.isArray(sessions) ? sessions : Object.values(sessions);
      status.sessions = {
        total: sessionList.length,
        list: sessionList.slice(0, 10).map(s => ({
          id: s.sessionKey || s.id || 'unknown',
          model: s.model || 'unknown',
          lastActive: s.lastActiveAt || s.updatedAt || null
        }))
      };
    } else { status.sessions = { total: 0, list: [] }; }
  } catch { status.sessions = { total: 0, list: [] }; }

  try {
    const connections = execSync("ss -tun state established | wc -l", { encoding: 'utf8' }).trim();
    status.network = { establishedConnections: parseInt(connections) - 1 };
  } catch { status.network = null; }

  try {
    const ps = execSync("ps aux --sort=-%cpu | head -6 | tail -5", { encoding: 'utf8' }).trim();
    status.topProcesses = ps.split('\n').map(line => {
      const parts = line.trim().split(/\s+/);
      return { user: parts[0], pid: parts[1], cpu: parts[2], mem: parts[3], command: parts.slice(10).join(' ') };
    });
  } catch { status.topProcesses = []; }

  return status;
}

// ─── HTTP Server ─────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  // API
  if (req.url === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify(collectStatus()));
    return;
  }

  // Gateway info (port, token, visitor IP)
  if (req.url === '/api/gateway-info') {
    let info = { port: 18789, token: '', panelUrl: '' };
    try {
      const cfgPath = path.join(process.env.HOME || '/root', '.openclaw/openclaw.json');
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
      info.panelUrl = `http://${ifaces[0] || 'localhost'}:${info.port}`;
    } catch {
      info.hostIps = [];
      info.panelUrl = `http://localhost:${info.port}`;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(info));
    return;
  }

  // Clear memory cache
  if (req.url === '/api/clear-cache' && req.method === 'POST') {
    try {
      execSync('sync && echo 3 > /proc/sys/vm/drop_caches', { encoding: 'utf8' });
      // Re-collect memory info
      const status = collectStatus();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, memory: status.memory, message: '缓存已清理' }));
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
      const configPath = path.join(process.env.HOME || '/root', '.openclaw/openclaw.json');
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
        const configPath = path.join(process.env.HOME || '/root', '.openclaw/openclaw.json');
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
        const configPath = path.join(process.env.HOME || '/root', '.openclaw/openclaw.json');
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
        const configPath = path.join(process.env.HOME || '/root', '.openclaw/openclaw.json');
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

// ─── Start ───────────────────────────────────────────────────────

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🖥️  OpenClaw 状态面板: http://localhost:${PORT}`);
  console.log(`📊 API:              http://localhost:${PORT}/api/status`);
});
