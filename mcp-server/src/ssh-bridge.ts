/**
 * SSH Bridge Worker
 * Executes SSH commands on behalf of MCP Server
 * Deployed to: ssh-bridge.ofshore.dev
 * 
 * This worker acts as a bridge between Cloudflare Workers and SSH
 * since CF Workers can't make direct SSH connections
 */

interface Env {
  // SSH credentials stored in CF secrets
  SSH_HOST: string;
  SSH_USER: string;
  SSH_PRIVATE_KEY: string;
  AUTH_TOKEN: string;
  
  // Optional: Coolify API for container management
  COOLIFY_URL: string;
  COOLIFY_TOKEN: string;
}

interface SSHRequest {
  host?: string;
  user?: string;
  privateKey?: string;
  command: string;
  timeout?: number;
}

interface SSHResponse {
  stdout: string;
  stderr: string;
  exitCode: number;
  duration: number;
}

// Since Cloudflare Workers can't do SSH directly, we have two options:
// 1. Use Coolify API to execute commands in containers
// 2. Call an external SSH service (like a small Node.js service on the server)

async function executeViaCoolifyAPI(env: Env, command: string, timeout: number): Promise<SSHResponse> {
  const startTime = Date.now();
  
  // Option 1: Execute in a privileged container that has SSH access
  // We'll create a special "ssh-executor" container for this
  
  const coolifyUrl = env.COOLIFY_URL || 'https://coolify.ofshore.dev';
  const coolifyToken = env.COOLIFY_TOKEN;
  
  if (!coolifyToken) {
    throw new Error('COOLIFY_TOKEN not configured');
  }

  // Use Coolify's execute API to run commands on the server
  // This requires a container with host networking or direct server access
  const response = await fetch(`${coolifyUrl}/api/v1/servers/0/execute`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${coolifyToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      command: command,
      timeout: timeout
    })
  });

  const duration = Date.now() - startTime;

  if (!response.ok) {
    const error = await response.text();
    return {
      stdout: '',
      stderr: `Coolify API error: ${error}`,
      exitCode: 1,
      duration
    };
  }

  const result = await response.json();
  
  return {
    stdout: result.output || result.stdout || '',
    stderr: result.error || result.stderr || '',
    exitCode: result.exitCode ?? (result.success ? 0 : 1),
    duration
  };
}

async function executeViaSSHService(env: Env, request: SSHRequest): Promise<SSHResponse> {
  const startTime = Date.now();
  
  // Option 2: Call a small SSH service running on the server itself
  // This service listens on localhost and executes SSH commands
  
  const sshServiceUrl = 'http://localhost:3022/exec';
  
  // We need to proxy this through something that can reach localhost
  // Using Cloudflare Tunnel or the server's public endpoint
  
  const tunnelUrl = `https://ssh-service.ofshore.dev/exec`;
  
  const response = await fetch(tunnelUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.AUTH_TOKEN}`
    },
    body: JSON.stringify({
      command: request.command,
      timeout: request.timeout || 30
    })
  });

  const duration = Date.now() - startTime;

  if (!response.ok) {
    const error = await response.text();
    return {
      stdout: '',
      stderr: `SSH service error: ${error}`,
      exitCode: 1,
      duration
    };
  }

  const result = await response.json();
  
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    exitCode: result.exitCode ?? 0,
    duration
  };
}

// Main worker handler
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        }
      });
    }

    // Health check
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({
        status: 'ok',
        timestamp: new Date().toISOString(),
        version: '1.0.0'
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Only POST to /exec
    if (request.method !== 'POST' || url.pathname !== '/exec') {
      return new Response('Not found', { status: 404 });
    }

    // Verify auth
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || authHeader !== `Bearer ${env.AUTH_TOKEN}`) {
      return new Response('Unauthorized', { status: 401 });
    }

    try {
      const body: SSHRequest = await request.json();
      
      if (!body.command) {
        return new Response(JSON.stringify({ error: 'Command required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Security: Basic command sanitization
      const dangerousPatterns = [
        /rm\s+-rf\s+\/(?!\s)/i,  // rm -rf / (but allow rm -rf /path)
        /mkfs/i,
        /dd\s+if=.*of=\/dev/i,
        />\s*\/dev\/sd/i
      ];
      
      for (const pattern of dangerousPatterns) {
        if (pattern.test(body.command)) {
          return new Response(JSON.stringify({
            error: 'Command blocked for safety',
            pattern: pattern.toString()
          }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }

      // Execute command
      let result: SSHResponse;
      
      if (env.COOLIFY_TOKEN) {
        // Prefer Coolify API if available
        result = await executeViaCoolifyAPI(env, body.command, body.timeout || 30);
      } else {
        // Fall back to SSH service
        result = await executeViaSSHService(env, body);
      }

      return new Response(JSON.stringify(result), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });

    } catch (error) {
      console.error('SSH Bridge error:', error);
      return new Response(JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        exitCode: 1
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
};
