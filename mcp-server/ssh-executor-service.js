const http = require('http');
const { execSync, spawn } = require('child_process');
const fs = require('fs');

const PORT = process.env.PORT || 3022;
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'change-me';
const MAX_TIMEOUT = parseInt(process.env.MAX_TIMEOUT) || 300;
const MAX_OUTPUT_SIZE = parseInt(process.env.MAX_OUTPUT_SIZE) || 1048576;

// Coolify integration for Docker operations
const COOLIFY_URL = process.env.COOLIFY_URL || 'https://coolify.ofshore.dev';
const COOLIFY_TOKEN = process.env.COOLIFY_TOKEN || '';

// Version
const VERSION = '3.0.0';

// Check if Docker socket is available
const DOCKER_SOCKET = '/var/run/docker.sock';
const hasDockerSocket = fs.existsSync(DOCKER_SOCKET);

console.log(`[ssh-executor v${VERSION}] Starting...`);
console.log(`[ssh-executor] Docker socket available: ${hasDockerSocket}`);
console.log(`[ssh-executor] Port: ${PORT}`);

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
    req.setTimeout(30000, () => reject(new Error('Timeout')));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function executeCommand(command, timeout = 60, workdir = null) {
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

// Docker helper functions - bezpośredni dostęp przez socket
async function dockerExec(args) {
  if (!hasDockerSocket) {
    return { error: 'Docker socket not available', hasSocket: false };
  }
  const cmd = `docker ${args}`;
  return await executeCommand(cmd, 120);
}

async function dockerComposeUp(projectPath) {
  if (!hasDockerSocket) {
    return { error: 'Docker socket not available' };
  }
  // Sprawdź czy ścieżka istnieje
  const checkPath = await executeCommand(`ls -la "${projectPath}" 2>&1`);
  if (checkPath.exitCode !== 0) {
    return { error: `Path not found: ${projectPath}`, details: checkPath.stderr };
  }
  
  // Uruchom docker compose
  const cmd = `cd "${projectPath}" && docker compose up -d 2>&1`;
  return await executeCommand(cmd, 300);
}

async function dockerComposeDown(projectPath) {
  if (!hasDockerSocket) {
    return { error: 'Docker socket not available' };
  }
  const cmd = `cd "${projectPath}" && docker compose down 2>&1`;
  return await executeCommand(cmd, 120);
}

async function dockerPs(filter = '') {
  if (!hasDockerSocket) {
    return { error: 'Docker socket not available' };
  }
  let cmd = 'docker ps -a --format "{{.ID}}\\t{{.Names}}\\t{{.Status}}\\t{{.Image}}"';
  if (filter) {
    cmd += ` --filter "name=${filter}"`;
  }
  return await executeCommand(cmd, 30);
}

async function dockerLogs(container, tail = 100) {
  if (!hasDockerSocket) {
    return { error: 'Docker socket not available' };
  }
  const cmd = `docker logs --tail ${tail} "${container}" 2>&1`;
  return await executeCommand(cmd, 30);
}

async function dockerRm(container, force = true) {
  if (!hasDockerSocket) {
    return { error: 'Docker socket not available' };
  }
  const cmd = force ? `docker rm -f "${container}" 2>&1` : `docker rm "${container}" 2>&1`;
  return await executeCommand(cmd, 30);
}

async function dockerRestart(container) {
  if (!hasDockerSocket) {
    return { error: 'Docker socket not available' };
  }
  const cmd = `docker restart "${container}" 2>&1`;
  return await executeCommand(cmd, 60);
}

async function dockerStop(container) {
  if (!hasDockerSocket) {
    return { error: 'Docker socket not available' };
  }
  const cmd = `docker stop "${container}" 2>&1`;
  return await executeCommand(cmd, 60);
}

async function dockerStart(container) {
  if (!hasDockerSocket) {
    return { error: 'Docker socket not available' };
  }
  const cmd = `docker start "${container}" 2>&1`;
  return await executeCommand(cmd, 60);
}

async function findDockerCompose(searchTerm) {
  // Szukaj docker-compose.yml z danym terminem
  const cmd = `find /home /opt /root /data /srv -name "docker-compose*" 2>/dev/null | xargs grep -l "${searchTerm}" 2>/dev/null | head -10`;
  return await executeCommand(cmd, 60);
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
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  // Health check - no auth
  if (path === '/health' && req.method === 'GET') {
    res.writeHead(200, headers);
    res.end(JSON.stringify({
      status: 'healthy',
      version: VERSION,
      dockerSocket: hasDockerSocket,
      uptime: process.uptime(),
      timestamp: new Date().toISOString()
    }));
    return;
  }

  // Auth check for all other endpoints
  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${AUTH_TOKEN}`) {
    res.writeHead(401, headers);
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  // Parse body for POST requests
  let body = {};
  if (req.method === 'POST') {
    try {
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      const rawBody = Buffer.concat(chunks).toString();
      if (rawBody) {
        body = JSON.parse(rawBody);
      }
    } catch (e) {
      res.writeHead(400, headers);
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }
  }

  try {
    // ========== CORE ENDPOINTS ==========
    
    // Execute shell command
    if (path === '/exec' && req.method === 'POST') {
      const { command, timeout = 60, workdir } = body;
      
      if (!command) {
        res.writeHead(400, headers);
        res.end(JSON.stringify({ error: 'command required' }));
        return;
      }
      
      if (isBlocked(command)) {
        res.writeHead(403, headers);
        res.end(JSON.stringify({ error: 'Command blocked for safety' }));
        return;
      }
      
      const result = await executeCommand(command, Math.min(timeout, MAX_TIMEOUT), workdir);
      res.writeHead(200, headers);
      res.end(JSON.stringify(result));
      return;
    }

    // ========== DOCKER DIRECT ENDPOINTS ==========
    
    // Docker ps - list containers
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
      if (!container) {
        res.writeHead(400, headers);
        res.end(JSON.stringify({ error: 'container parameter required' }));
        return;
      }
      const result = await dockerLogs(container, tail);
      res.writeHead(200, headers);
      res.end(JSON.stringify({ ok: true, container, ...result }));
      return;
    }
    
    // Docker restart/stop/start/rm
    if (path === '/docker/control' && req.method === 'POST') {
      const { action, container } = body;
      if (!container || !action) {
        res.writeHead(400, headers);
        res.end(JSON.stringify({ error: 'action and container required' }));
        return;
      }
      
      let result;
      switch (action) {
        case 'restart':
          result = await dockerRestart(container);
          break;
        case 'stop':
          result = await dockerStop(container);
          break;
        case 'start':
          result = await dockerStart(container);
          break;
        case 'rm':
          result = await dockerRm(container, true);
          break;
        default:
          res.writeHead(400, headers);
          res.end(JSON.stringify({ error: 'Invalid action. Use: restart, stop, start, rm' }));
          return;
      }
      
      res.writeHead(200, headers);
      res.end(JSON.stringify({ ok: true, action, container, ...result }));
      return;
    }
    
    // Docker compose up
    if (path === '/docker/compose/up' && req.method === 'POST') {
      const { path: projectPath } = body;
      if (!projectPath) {
        res.writeHead(400, headers);
        res.end(JSON.stringify({ error: 'path required (directory with docker-compose.yml)' }));
        return;
      }
      
      const result = await dockerComposeUp(projectPath);
      res.writeHead(200, headers);
      res.end(JSON.stringify({ ok: !result.error, path: projectPath, ...result }));
      return;
    }
    
    // Docker compose down
    if (path === '/docker/compose/down' && req.method === 'POST') {
      const { path: projectPath } = body;
      if (!projectPath) {
        res.writeHead(400, headers);
        res.end(JSON.stringify({ error: 'path required (directory with docker-compose.yml)' }));
        return;
      }
      
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
    
    // Docker exec (run command inside container)
    if (path === '/docker/exec' && req.method === 'POST') {
      const { container, command } = body;
      if (!container || !command) {
        res.writeHead(400, headers);
        res.end(JSON.stringify({ error: 'container and command required' }));
        return;
      }
      
      const result = await dockerExec(`exec ${container} ${command}`);
      res.writeHead(200, headers);
      res.end(JSON.stringify({ ok: !result.error, container, command, ...result }));
      return;
    }

    // ========== COOLIFY API PROXY ==========
    
    // List apps via Coolify
    if (path === '/apps' && req.method === 'GET') {
      const result = await coolifyRequest('GET', '/api/v1/applications');
      if (!result.ok) {
        res.writeHead(500, headers);
        res.end(JSON.stringify({ error: 'Coolify API error', details: result.data }));
        return;
      }
      
      const apps = result.data.map(app => ({
        uuid: app.uuid,
        name: app.name,
        status: app.status,
        fqdn: app.fqdn
      }));
      
      res.writeHead(200, headers);
      res.end(JSON.stringify({ ok: true, count: apps.length, apps }));
      return;
    }
    
    // Docker operations via Coolify API
    if (path === '/docker' && req.method === 'POST') {
      const { action, app_uuid } = body;
      
      if (!action || !app_uuid) {
        res.writeHead(400, headers);
        res.end(JSON.stringify({ error: 'action and app_uuid required' }));
        return;
      }
      
      let endpoint = '';
      switch (action) {
        case 'restart':
          endpoint = `/api/v1/applications/${app_uuid}/restart`;
          break;
        case 'stop':
          endpoint = `/api/v1/applications/${app_uuid}/stop`;
          break;
        case 'start':
          endpoint = `/api/v1/applications/${app_uuid}/start`;
          break;
        default:
          res.writeHead(400, headers);
          res.end(JSON.stringify({ error: 'Invalid action. Use: restart, stop, start' }));
          return;
      }
      
      const result = await coolifyRequest('POST', endpoint);
      res.writeHead(200, headers);
      res.end(JSON.stringify({ ok: result.ok, action, app_uuid, result: result.data }));
      return;
    }
    
    // Deploy via Coolify
    if (path === '/deploy' && req.method === 'POST') {
      const { uuid, force = false } = body;
      
      if (!uuid) {
        res.writeHead(400, headers);
        res.end(JSON.stringify({ error: 'uuid required' }));
        return;
      }
      
      const endpoint = `/api/v1/applications/${uuid}/deploy?force=${force}`;
      const result = await coolifyRequest('POST', endpoint);
      
      res.writeHead(200, headers);
      res.end(JSON.stringify({ ok: result.ok, uuid, result: result.data }));
      return;
    }
    
    // System info
    if (path === '/system' && req.method === 'GET') {
      const [uptime, memory, disk, hostname] = await Promise.all([
        executeCommand('uptime', 5),
        executeCommand('free -h', 5),
        executeCommand('df -h / | tail -1', 5),
        executeCommand('hostname', 5)
      ]);
      
      // Get Coolify server info
      let coolifyInfo = null;
      try {
        const result = await coolifyRequest('GET', '/api/v1/servers');
        if (result.ok) {
          coolifyInfo = result.data;
        }
      } catch (e) {}
      
      res.writeHead(200, headers);
      res.end(JSON.stringify({
        ok: true,
        version: VERSION,
        dockerSocket: hasDockerSocket,
        hostname: hostname.stdout?.trim(),
        uptime: uptime.stdout?.trim(),
        memory: memory.stdout?.trim(),
        disk: disk.stdout?.trim(),
        coolify: coolifyInfo
      }));
      return;
    }
    
    // API docs
    if (path === '/' && req.method === 'GET') {
      res.writeHead(200, headers);
      res.end(JSON.stringify({
        name: 'ssh-executor',
        version: VERSION,
        dockerSocket: hasDockerSocket,
        endpoints: {
          'GET /health': 'Health check (no auth)',
          'GET /': 'This documentation',
          'POST /exec': 'Execute shell command {command, timeout?, workdir?}',
          'GET /docker/ps?filter=': 'List Docker containers (direct)',
          'GET /docker/logs?container=&tail=': 'Get container logs (direct)',
          'POST /docker/control': 'Control container {action: restart|stop|start|rm, container}',
          'POST /docker/compose/up': 'Docker compose up {path}',
          'POST /docker/compose/down': 'Docker compose down {path}',
          'GET /docker/compose/find?search=': 'Find docker-compose files',
          'POST /docker/exec': 'Execute command in container {container, command}',
          'GET /apps': 'List Coolify apps',
          'POST /docker': 'Control Coolify app {action, app_uuid}',
          'POST /deploy': 'Deploy Coolify app {uuid, force?}',
          'GET /system': 'System information'
        }
      }));
      return;
    }
    
    // 404
    res.writeHead(404, headers);
    res.end(JSON.stringify({ error: 'Not found', path }));
    
  } catch (error) {
    console.error('[ssh-executor] Error:', error);
    res.writeHead(500, headers);
    res.end(JSON.stringify({ error: error.message }));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[ssh-executor v${VERSION}] Running on port ${PORT}`);
  console.log(`[ssh-executor] Docker socket: ${hasDockerSocket ? 'AVAILABLE' : 'NOT AVAILABLE'}`);
});
