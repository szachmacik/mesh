#!/bin/bash
# SSH-EXECUTOR STANDALONE INSTALLER
# Uruchom na serwerze: curl -fsSL https://raw.githubusercontent.com/szachmacik/mesh/main/setup-ssh-executor.sh | bash
# Albo: bash setup-ssh-executor.sh

set -e

echo "🚀 Instalacja SSH-Executor v3.0.0 z Docker socket..."

# Konfiguracja
AUTH_TOKEN="${AUTH_TOKEN:-b554f5dce9ce925e9da21b44f288cdf402c8daabbff56fe7d7ed60fe60e771d5}"
COOLIFY_TOKEN="${COOLIFY_TOKEN:-11|XEeSb5dSVT6ldvdg3pFn3oOvMROvSvtPlj5aUeI7b041f38c}"
COOLIFY_URL="${COOLIFY_URL:-https://coolify.ofshore.dev}"
PORT="${PORT:-3023}"  # Inny port niż Coolify wersja

# Sprawdź czy Docker działa
if ! docker info > /dev/null 2>&1; then
    echo "❌ Docker nie jest dostępny"
    exit 1
fi

# Katalog roboczy
INSTALL_DIR="/opt/ssh-executor"
mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

# Zatrzymaj starą wersję jeśli istnieje
docker stop ssh-executor-standalone 2>/dev/null || true
docker rm ssh-executor-standalone 2>/dev/null || true

# Tworzę kod Node.js
cat > ssh-executor.js << 'NODEJS_CODE'
const http = require('http');
const { execSync } = require('child_process');
const fs = require('fs');

const PORT = process.env.PORT || 3023;
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'change-me';
const MAX_TIMEOUT = parseInt(process.env.MAX_TIMEOUT) || 300;
const MAX_OUTPUT_SIZE = parseInt(process.env.MAX_OUTPUT_SIZE) || 1048576;
const COOLIFY_URL = process.env.COOLIFY_URL || 'https://coolify.ofshore.dev';
const COOLIFY_TOKEN = process.env.COOLIFY_TOKEN || '';
const VERSION = '3.0.0-standalone';

const DOCKER_SOCKET = '/var/run/docker.sock';
const hasDockerSocket = fs.existsSync(DOCKER_SOCKET);

console.log(`[ssh-executor v${VERSION}] Starting...`);
console.log(`[ssh-executor] Docker socket: ${hasDockerSocket ? 'AVAILABLE ✅' : 'NOT AVAILABLE ❌'}`);
console.log(`[ssh-executor] Port: ${PORT}`);

const BLOCKED_COMMANDS = ['rm -rf /', 'mkfs', ':(){:|:&};:', 'dd if=/dev/zero of=/dev', '> /dev/sda', 'chmod -R 777 /'];

function isBlocked(cmd) {
  return BLOCKED_COMMANDS.some(blocked => cmd.includes(blocked));
}

async function coolifyRequest(method, path, body = null) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const url = new URL(path, COOLIFY_URL);
    const options = {
      hostname: url.hostname, port: 443, path: url.pathname, method,
      headers: { 'Authorization': `Bearer ${COOLIFY_TOKEN}`, 'Content-Type': 'application/json', 'Accept': 'application/json' }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ ok: res.statusCode < 400, status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ ok: res.statusCode < 400, status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => reject(new Error('Timeout')));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function executeCommand(command, timeout = 60, workdir = null) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    try {
      const options = { encoding: 'utf-8', timeout: timeout * 1000, maxBuffer: MAX_OUTPUT_SIZE, shell: true };
      if (workdir) options.cwd = workdir;
      const stdout = execSync(command, options);
      resolve({ stdout, stderr: '', exitCode: 0, duration: Date.now() - startTime });
    } catch (error) {
      resolve({ stdout: error.stdout?.toString() || '', stderr: error.stderr?.toString() || error.message, exitCode: error.status || 1, duration: Date.now() - startTime });
    }
  });
}

// Docker helper functions
async function dockerExec(args) {
  if (!hasDockerSocket) return { error: 'Docker socket not available', hasSocket: false };
  return await executeCommand(`docker ${args}`, 120);
}

async function dockerComposeUp(projectPath) {
  if (!hasDockerSocket) return { error: 'Docker socket not available' };
  const checkPath = await executeCommand(`ls -la "${projectPath}" 2>&1`);
  if (checkPath.exitCode !== 0) return { error: `Path not found: ${projectPath}`, details: checkPath.stderr };
  return await executeCommand(`cd "${projectPath}" && docker compose up -d 2>&1`, 300);
}

async function dockerComposeDown(projectPath) {
  if (!hasDockerSocket) return { error: 'Docker socket not available' };
  return await executeCommand(`cd "${projectPath}" && docker compose down 2>&1`, 120);
}

async function dockerPs(filter = '') {
  if (!hasDockerSocket) return { error: 'Docker socket not available' };
  let cmd = 'docker ps -a --format "{{.ID}}\\t{{.Names}}\\t{{.Status}}\\t{{.Image}}"';
  if (filter) cmd += ` --filter "name=${filter}"`;
  return await executeCommand(cmd, 30);
}

async function dockerLogs(container, tail = 100) {
  if (!hasDockerSocket) return { error: 'Docker socket not available' };
  return await executeCommand(`docker logs --tail ${tail} "${container}" 2>&1`, 30);
}

async function findDockerCompose(searchTerm) {
  const cmd = `find /home /opt /root /data /srv -name "docker-compose*" 2>/dev/null | xargs grep -l "${searchTerm}" 2>/dev/null | head -10`;
  return await executeCommand(cmd, 60);
}

const server = http.createServer(async (req, res) => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' };
  
  if (req.method === 'OPTIONS') { res.writeHead(204, headers); res.end(); return; }
  
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  // Health check - no auth
  if (path === '/health' && req.method === 'GET') {
    res.writeHead(200, headers);
    res.end(JSON.stringify({ status: 'healthy', version: VERSION, dockerSocket: hasDockerSocket, uptime: process.uptime(), timestamp: new Date().toISOString() }));
    return;
  }

  // Auth check
  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${AUTH_TOKEN}`) {
    res.writeHead(401, headers);
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  // Parse body for POST
  let body = {};
  if (req.method === 'POST') {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const rawBody = Buffer.concat(chunks).toString();
      if (rawBody) body = JSON.parse(rawBody);
    } catch (e) {
      res.writeHead(400, headers);
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }
  }

  try {
    // Shell command
    if (path === '/exec' && req.method === 'POST') {
      const { command, timeout = 60, workdir } = body;
      if (!command) { res.writeHead(400, headers); res.end(JSON.stringify({ error: 'command required' })); return; }
      if (isBlocked(command)) { res.writeHead(403, headers); res.end(JSON.stringify({ error: 'Command blocked' })); return; }
      const result = await executeCommand(command, Math.min(timeout, MAX_TIMEOUT), workdir);
      res.writeHead(200, headers);
      res.end(JSON.stringify(result));
      return;
    }

    // Docker ps
    if (path === '/docker/ps' && req.method === 'GET') {
      const filter = url.searchParams.get('filter') || '';
      const result = await dockerPs(filter);
      res.writeHead(200, headers);
      res.end(JSON.stringify({ ok: true, hasSocket: hasDockerSocket, ...result }));
      return;
    }

    // Docker logs
    if (path === '/docker/logs' && req.method === 'GET') {
      const container = url.searchParams.get('container');
      const tail = parseInt(url.searchParams.get('tail')) || 100;
      if (!container) { res.writeHead(400, headers); res.end(JSON.stringify({ error: 'container required' })); return; }
      const result = await dockerLogs(container, tail);
      res.writeHead(200, headers);
      res.end(JSON.stringify({ ok: true, container, ...result }));
      return;
    }

    // Docker control (restart/stop/start/rm)
    if (path === '/docker/control' && req.method === 'POST') {
      const { action, container } = body;
      if (!container || !action) { res.writeHead(400, headers); res.end(JSON.stringify({ error: 'action and container required' })); return; }
      let result;
      switch (action) {
        case 'restart': result = await executeCommand(`docker restart "${container}" 2>&1`, 60); break;
        case 'stop': result = await executeCommand(`docker stop "${container}" 2>&1`, 60); break;
        case 'start': result = await executeCommand(`docker start "${container}" 2>&1`, 60); break;
        case 'rm': result = await executeCommand(`docker rm -f "${container}" 2>&1`, 30); break;
        default: res.writeHead(400, headers); res.end(JSON.stringify({ error: 'Invalid action' })); return;
      }
      res.writeHead(200, headers);
      res.end(JSON.stringify({ ok: true, action, container, ...result }));
      return;
    }

    // Docker compose up
    if (path === '/docker/compose/up' && req.method === 'POST') {
      const { path: projectPath } = body;
      if (!projectPath) { res.writeHead(400, headers); res.end(JSON.stringify({ error: 'path required' })); return; }
      const result = await dockerComposeUp(projectPath);
      res.writeHead(200, headers);
      res.end(JSON.stringify({ ok: !result.error, path: projectPath, ...result }));
      return;
    }

    // Docker compose down
    if (path === '/docker/compose/down' && req.method === 'POST') {
      const { path: projectPath } = body;
      if (!projectPath) { res.writeHead(400, headers); res.end(JSON.stringify({ error: 'path required' })); return; }
      const result = await dockerComposeDown(projectPath);
      res.writeHead(200, headers);
      res.end(JSON.stringify({ ok: !result.error, path: projectPath, ...result }));
      return;
    }

    // Find docker-compose files
    if (path === '/docker/compose/find' && req.method === 'GET') {
      const search = url.searchParams.get('search') || '';
      const result = await findDockerCompose(search);
      res.writeHead(200, headers);
      res.end(JSON.stringify({ ok: true, search, ...result }));
      return;
    }

    // Docker exec
    if (path === '/docker/exec' && req.method === 'POST') {
      const { container, command } = body;
      if (!container || !command) { res.writeHead(400, headers); res.end(JSON.stringify({ error: 'container and command required' })); return; }
      const result = await dockerExec(`exec ${container} ${command}`);
      res.writeHead(200, headers);
      res.end(JSON.stringify({ ok: !result.error, container, command, ...result }));
      return;
    }

    // Coolify apps
    if (path === '/apps' && req.method === 'GET') {
      const result = await coolifyRequest('GET', '/api/v1/applications');
      if (!result.ok) { res.writeHead(500, headers); res.end(JSON.stringify({ error: 'Coolify API error' })); return; }
      const apps = result.data.map(app => ({ uuid: app.uuid, name: app.name, status: app.status, fqdn: app.fqdn }));
      res.writeHead(200, headers);
      res.end(JSON.stringify({ ok: true, count: apps.length, apps }));
      return;
    }

    // Coolify control
    if (path === '/docker' && req.method === 'POST') {
      const { action, app_uuid } = body;
      if (!action || !app_uuid) { res.writeHead(400, headers); res.end(JSON.stringify({ error: 'action and app_uuid required' })); return; }
      const endpoints = { restart: '/restart', stop: '/stop', start: '/start' };
      if (!endpoints[action]) { res.writeHead(400, headers); res.end(JSON.stringify({ error: 'Invalid action' })); return; }
      const result = await coolifyRequest('POST', `/api/v1/applications/${app_uuid}${endpoints[action]}`);
      res.writeHead(200, headers);
      res.end(JSON.stringify({ ok: result.ok, action, app_uuid, result: result.data }));
      return;
    }

    // System info
    if (path === '/system' && req.method === 'GET') {
      const [uptime, memory, disk, hostname] = await Promise.all([
        executeCommand('uptime', 5), executeCommand('free -h', 5), executeCommand('df -h / | tail -1', 5), executeCommand('hostname', 5)
      ]);
      res.writeHead(200, headers);
      res.end(JSON.stringify({ ok: true, version: VERSION, dockerSocket: hasDockerSocket, hostname: hostname.stdout?.trim(), uptime: uptime.stdout?.trim(), memory: memory.stdout?.trim(), disk: disk.stdout?.trim() }));
      return;
    }

    // API docs
    if (path === '/' && req.method === 'GET') {
      res.writeHead(200, headers);
      res.end(JSON.stringify({
        name: 'ssh-executor-standalone', version: VERSION, dockerSocket: hasDockerSocket,
        endpoints: {
          'GET /health': 'Health check (no auth)',
          'POST /exec': 'Execute shell command {command, timeout?, workdir?}',
          'GET /docker/ps': 'List containers',
          'GET /docker/logs?container=&tail=': 'Container logs',
          'POST /docker/control': 'Control container {action, container}',
          'POST /docker/compose/up': 'Docker compose up {path}',
          'POST /docker/compose/down': 'Docker compose down {path}',
          'GET /docker/compose/find?search=': 'Find docker-compose files',
          'POST /docker/exec': 'Execute in container {container, command}',
          'GET /apps': 'List Coolify apps',
          'POST /docker': 'Coolify control {action, app_uuid}',
          'GET /system': 'System info'
        }
      }));
      return;
    }

    res.writeHead(404, headers);
    res.end(JSON.stringify({ error: 'Not found' }));
  } catch (error) {
    console.error('[ssh-executor] Error:', error);
    res.writeHead(500, headers);
    res.end(JSON.stringify({ error: error.message }));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[ssh-executor v${VERSION}] Running on port ${PORT}`);
  console.log(`[ssh-executor] Docker socket: ${hasDockerSocket ? 'AVAILABLE ✅' : 'NOT AVAILABLE ❌'}`);
});
NODEJS_CODE

# Tworzę Dockerfile
cat > Dockerfile << 'DOCKERFILE'
FROM node:20-alpine
RUN apk add --no-cache docker-cli docker-cli-compose curl bash findutils grep
WORKDIR /app
COPY ssh-executor.js ./
ENV PORT=3023
EXPOSE 3023
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 CMD curl -f http://localhost:3023/health || exit 1
CMD ["node", "ssh-executor.js"]
DOCKERFILE

# Build image
echo "📦 Budowanie obrazu..."
docker build -t ssh-executor-standalone:latest .

# Uruchom container z Docker socket
echo "🐳 Uruchamianie kontenera z Docker socket..."
docker run -d \
  --name ssh-executor-standalone \
  --restart unless-stopped \
  -p ${PORT}:3023 \
  -v /var/run/docker.sock:/var/run/docker.sock:rw \
  -v /home:/home:rw \
  -v /opt:/opt:rw \
  -v /root:/root:rw \
  -v /data:/data:rw \
  -e AUTH_TOKEN="${AUTH_TOKEN}" \
  -e COOLIFY_TOKEN="${COOLIFY_TOKEN}" \
  -e COOLIFY_URL="${COOLIFY_URL}" \
  -e PORT=3023 \
  ssh-executor-standalone:latest

# Poczekaj na start
sleep 3

# Test
echo ""
echo "🧪 Test..."
HEALTH=$(curl -s http://localhost:${PORT}/health)
echo "Health: $HEALTH"

DOCKER_TEST=$(curl -s -X POST http://localhost:${PORT}/exec \
  -H "Authorization: Bearer ${AUTH_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"command": "docker ps --format \"{{.Names}}\" | head -3"}')
echo "Docker test: $DOCKER_TEST"

echo ""
echo "✅ SSH-Executor Standalone zainstalowany!"
echo ""
echo "📍 Endpoint: http://localhost:${PORT}"
echo "📍 Health: http://localhost:${PORT}/health"
echo ""
echo "🔑 Token: ${AUTH_TOKEN}"
echo ""
echo "Przykład użycia:"
echo "  curl -X POST http://localhost:${PORT}/docker/ps -H 'Authorization: Bearer ${AUTH_TOKEN}'"
echo ""
