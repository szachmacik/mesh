/**
 * SSH Executor Service
 * Runs directly on the DigitalOcean server
 * Executes commands locally via child_process
 * 
 * Deploy to: Coolify as Docker container
 * Port: 3022 (internal), exposed via Cloudflare Tunnel
 */

const http = require('http');
const { exec, spawn } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

// Configuration
const PORT = process.env.PORT || 3022;
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'change-me-in-production';
const MAX_TIMEOUT = parseInt(process.env.MAX_TIMEOUT || '300', 10);
const MAX_OUTPUT_SIZE = parseInt(process.env.MAX_OUTPUT_SIZE || '1048576', 10); // 1MB

// Dangerous command patterns
const BLOCKED_PATTERNS = [
  /rm\s+-rf\s+\/\s*$/i,
  /rm\s+-rf\s+\/\s*$/i,
  /mkfs\s+/i,
  /dd\s+if=.*of=\/dev\/[sh]d/i,
  />\s*\/dev\/[sh]d/i,
  /chmod\s+-R\s+777\s+\//i,
  /:(){ :\|:& };:/,  // Fork bomb
];

// Parse JSON body
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1e6) { // 1MB limit
        reject(new Error('Request too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });
  });
}

// Execute command with timeout
async function executeCommand(command, timeout = 30) {
  const startTime = Date.now();
  
  // Check for dangerous patterns
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      return {
        stdout: '',
        stderr: `Command blocked by security filter: ${pattern}`,
        exitCode: 1,
        duration: Date.now() - startTime,
        blocked: true
      };
    }
  }

  // Enforce timeout limits
  const actualTimeout = Math.min(timeout, MAX_TIMEOUT) * 1000;

  return new Promise((resolve) => {
    exec(command, {
      timeout: actualTimeout,
      maxBuffer: MAX_OUTPUT_SIZE,
      shell: '/bin/bash',
      env: {
        ...process.env,
        PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
      }
    }, (error, stdout, stderr) => {
      const duration = Date.now() - startTime;
      
      if (error) {
        // Check if it was a timeout
        if (error.killed && error.signal === 'SIGTERM') {
          resolve({
            stdout: stdout || '',
            stderr: `Command timed out after ${timeout} seconds`,
            exitCode: 124, // Standard timeout exit code
            duration,
            timedOut: true
          });
          return;
        }

        resolve({
          stdout: stdout || '',
          stderr: stderr || error.message,
          exitCode: error.code || 1,
          duration
        });
        return;
      }

      resolve({
        stdout: stdout || '',
        stderr: stderr || '',
        exitCode: 0,
        duration
      });
    });
  });
}

// HTTP Server
const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check
  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      version: '1.0.0'
    }));
    return;
  }

  // Only POST /exec
  if (req.url !== '/exec' || req.method !== 'POST') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  // Auth check
  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${AUTH_TOKEN}`) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  try {
    const body = await parseBody(req);
    
    if (!body.command) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Command required' }));
      return;
    }

    console.log(`[${new Date().toISOString()}] Executing: ${body.command.substring(0, 100)}...`);

    const result = await executeCommand(body.command, body.timeout || 30);

    console.log(`[${new Date().toISOString()}] Completed in ${result.duration}ms, exit code: ${result.exitCode}`);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));

  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error:`, error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: error.message,
      exitCode: 1
    }));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`SSH Executor Service listening on port ${PORT}`);
  console.log(`Auth token: ${AUTH_TOKEN.substring(0, 8)}...`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
