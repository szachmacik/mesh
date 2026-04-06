const http = require('http');
const { execSync, spawn } = require('child_process');

const PORT = process.env.PORT || 3022;
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'change-me';
const MAX_TIMEOUT = parseInt(process.env.MAX_TIMEOUT) || 300;
const MAX_OUTPUT_SIZE = parseInt(process.env.MAX_OUTPUT_SIZE) || 1048576;

// Coolify integration for Docker operations
const COOLIFY_URL = process.env.COOLIFY_URL || 'https://coolify.ofshore.dev';
const COOLIFY_TOKEN = process.env.COOLIFY_TOKEN || '11|XEeSb5dSVT6ldvdg3pFn3oOvMROvSvtPlj5aUeI7b041f38c';

const BLOCKED_COMMANDS = [
  'rm -rf /',
  'mkfs',
  ':(){:|:&};:',
  'dd if=/dev/zero of=/dev',
  '> /dev/sda',
  'chmod -R 777 /',
];

function isBlocked(cmd) {
  return BLOCKED_COMMANDS.some(blocked => cmd.includes(blocked));
}

async function coolifyRequest(method, path, body = null) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const url = new URL(path, COOLIFY_URL);
    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname,
      method: method,
      headers: {
        'Authorization': `Bearer ${COOLIFY_TOKEN}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    };
    
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ ok: res.statusCode < 400, status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ ok: res.statusCode < 400, status: res.statusCode, data: data });
        }
      });
    });
    
    req.on('error', reject);
    req.setTimeout(10000, () => reject(new Error('Timeout')));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function executeCommand(command, timeout = 30, workdir = null) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    
    try {
      const options = {
        encoding: 'utf-8',
        timeout: timeout * 1000,
        maxBuffer: MAX_OUTPUT_SIZE,
        shell: true
      };
      
      if (workdir) options.cwd = workdir;
      
      const stdout = execSync(command, options);
      resolve({
        stdout: stdout,
        stderr: '',
        exitCode: 0,
        duration: Date.now() - startTime
      });
    } catch (error) {
      resolve({
        stdout: error.stdout?.toString() || '',
        stderr: error.stderr?.toString() || error.message,
        exitCode: error.status || 1,
        duration: Date.now() - startTime
      });
    }
  });
}

const server = http.createServer(async (req, res) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  };

  if (req.method === 'OPTIONS') {
    res.writeHead(204, headers);
    return res.end();
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Health check - no auth required
  if (url.pathname === '/health') {
    res.writeHead(200, headers);
    return res.end(JSON.stringify({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      version: '2.0.0',
      features: ['exec', 'coolify-docker', 'apps', 'deploy']
    }));
  }

  // Auth check for other endpoints
  const auth = req.headers['authorization'];
  if (!auth || !auth.includes(AUTH_TOKEN)) {
    res.writeHead(401, headers);
    return res.end(JSON.stringify({ error: 'Unauthorized' }));
  }

  // Parse body for POST requests
  let body = {};
  if (req.method === 'POST') {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = JSON.parse(Buffer.concat(chunks).toString());
    } catch (e) {
      body = {};
    }
  }

  // Execute command
  if (url.pathname === '/exec' && req.method === 'POST') {
    const { command, timeout = 30, workdir } = body;
    
    if (!command) {
      res.writeHead(400, headers);
      return res.end(JSON.stringify({ error: 'Missing command' }));
    }

    if (isBlocked(command)) {
      res.writeHead(403, headers);
      return res.end(JSON.stringify({ error: 'Command blocked for safety' }));
    }

    const result = await executeCommand(command, Math.min(timeout, MAX_TIMEOUT), workdir);
    res.writeHead(200, headers);
    return res.end(JSON.stringify(result));
  }

  // Docker operations via Coolify API (fallback when no direct Docker access)
  if (url.pathname === '/docker' && req.method === 'POST') {
    const { action, app_uuid } = body;
    
    if (!action || !app_uuid) {
      res.writeHead(400, headers);
      return res.end(JSON.stringify({ error: 'Missing action or app_uuid' }));
    }

    try {
      const result = await coolifyRequest('GET', `/api/v1/applications/${app_uuid}/${action}`);
      res.writeHead(200, headers);
      return res.end(JSON.stringify({ ok: result.ok, action, app_uuid, result: result.data }));
    } catch (e) {
      res.writeHead(500, headers);
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // List apps via Coolify
  if (url.pathname === '/apps') {
    try {
      const result = await coolifyRequest('GET', '/api/v1/applications');
      const apps = Array.isArray(result.data) ? result.data.map(a => ({
        uuid: a.uuid,
        name: a.name,
        status: a.status
      })) : [];
      res.writeHead(200, headers);
      return res.end(JSON.stringify({ ok: true, count: apps.length, apps }));
    } catch (e) {
      res.writeHead(500, headers);
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // Deploy via Coolify
  if (url.pathname === '/deploy' && req.method === 'POST') {
    const { uuid, force = false } = body;
    
    if (!uuid) {
      res.writeHead(400, headers);
      return res.end(JSON.stringify({ error: 'Missing uuid' }));
    }

    try {
      const result = await coolifyRequest('POST', '/api/v1/deploy', { uuid, force });
      res.writeHead(200, headers);
      return res.end(JSON.stringify({ ok: result.ok, deployments: result.data }));
    } catch (e) {
      res.writeHead(500, headers);
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // System info
  if (url.pathname === '/system') {
    const sysInfo = await executeCommand('hostname && uptime && df -h / | tail -1', 5);
    try {
      const coolifyServer = await coolifyRequest('GET', '/api/v1/servers/iswgwwcccc408o8kgkccccss');
      res.writeHead(200, headers);
      return res.end(JSON.stringify({
        ok: true,
        local: sysInfo,
        coolify_server: coolifyServer.data
      }));
    } catch {
      res.writeHead(200, headers);
      return res.end(JSON.stringify({ ok: true, local: sysInfo }));
    }
  }

  // API docs
  res.writeHead(200, headers);
  res.end(JSON.stringify({
    service: 'ssh-executor',
    version: '2.0.0',
    endpoints: {
      '/health': 'GET - Health check (no auth)',
      '/exec': 'POST {command, timeout?, workdir?} - Execute shell command',
      '/docker': 'POST {action, app_uuid} - Docker via Coolify API (restart/stop/start)',
      '/apps': 'GET - List Coolify applications',
      '/deploy': 'POST {uuid, force?} - Trigger deployment',
      '/system': 'GET - System information'
    }
  }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`SSH Executor v2.0.0 listening on port ${PORT}`);
  console.log(`Coolify integration: ${COOLIFY_URL}`);
});
