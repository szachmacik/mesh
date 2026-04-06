/**
 * SSH Executor Worker for Cloudflare
 * Direct REST API for SSH command execution
 * 
 * Endpoints:
 *   POST /exec - Execute command
 *   POST /docker - Execute in Docker container  
 *   POST /file/read - Read file
 *   POST /file/write - Write file
 *   GET /system - System info
 *   GET /health - Health check
 */

interface Env {
  SSH_HOST: string;
  SSH_USER: string;
  AUTH_TOKEN: string;
  COOLIFY_URL: string;
  COOLIFY_TOKEN: string;
}

interface ExecRequest {
  command: string;
  timeout?: number;
  workdir?: string;
}

interface ExecResponse {
  stdout: string;
  stderr: string;
  exitCode: number;
  duration: number;
}

// Blocked dangerous commands
const BLOCKED_PATTERNS = [
  /rm\s+-rf\s+\/\s*$/i,
  /mkfs/i,
  /dd\s+if=.*of=\/dev/i,
];

function isBlocked(command: string): boolean {
  return BLOCKED_PATTERNS.some(p => p.test(command));
}

// Execute via Coolify API
async function executeCommand(env: Env, command: string, timeout: number = 30): Promise<ExecResponse> {
  const startTime = Date.now();

  if (isBlocked(command)) {
    return {
      stdout: '',
      stderr: 'Command blocked by security filter',
      exitCode: 1,
      duration: Date.now() - startTime
    };
  }

  const coolifyUrl = env.COOLIFY_URL || 'https://coolify.ofshore.dev';
  
  try {
    // Method 1: Coolify server execute
    const response = await fetch(`${coolifyUrl}/api/v1/servers/0/execute`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.COOLIFY_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ command })
    });

    if (response.ok) {
      const result = await response.json() as any;
      return {
        stdout: result.output || result.stdout || '',
        stderr: result.error || result.stderr || '',
        exitCode: result.exit_code ?? (result.success ? 0 : 1),
        duration: Date.now() - startTime
      };
    }

    // Method 2: ssh-executor service
    const executorResponse = await fetch('https://ssh-executor.ofshore.dev/exec', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.AUTH_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ command, timeout })
    });

    if (executorResponse.ok) {
      return await executorResponse.json() as ExecResponse;
    }

    throw new Error(`Execution failed: ${await executorResponse.text()}`);

  } catch (error) {
    return {
      stdout: '',
      stderr: `Error: ${error instanceof Error ? error.message : String(error)}`,
      exitCode: 1,
      duration: Date.now() - startTime
    };
  }
}

// Auth check
function checkAuth(request: Request, env: Env): Response | null {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || authHeader !== `Bearer ${env.AUTH_TOKEN}`) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  return null;
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders }
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Health check (no auth)
    if (path === '/health' || path === '/') {
      return jsonResponse({
        status: 'ok',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        endpoints: ['/exec', '/docker', '/file/read', '/file/write', '/system']
      });
    }

    // Auth required for other endpoints
    const authError = checkAuth(request, env);
    if (authError) return authError;

    try {
      // POST /exec
      if (path === '/exec' && method === 'POST') {
        const body = await request.json() as ExecRequest;
        if (!body.command) {
          return jsonResponse({ error: 'Command required' }, 400);
        }
        let cmd = body.command;
        if (body.workdir) {
          cmd = `cd ${body.workdir} && ${cmd}`;
        }
        const result = await executeCommand(env, cmd, body.timeout || 30);
        return jsonResponse(result);
      }

      // POST /docker
      if (path === '/docker' && method === 'POST') {
        const body = await request.json() as { container: string; command: string; workdir?: string };
        if (!body.container || !body.command) {
          return jsonResponse({ error: 'Container and command required' }, 400);
        }
        let dockerCmd = `docker exec`;
        if (body.workdir) {
          dockerCmd += ` -w "${body.workdir}"`;
        }
        dockerCmd += ` ${body.container} ${body.command}`;
        const result = await executeCommand(env, dockerCmd, 60);
        return jsonResponse(result);
      }

      // POST /file/read
      if (path === '/file/read' && method === 'POST') {
        const body = await request.json() as { path: string; lines?: number };
        if (!body.path) {
          return jsonResponse({ error: 'Path required' }, 400);
        }
        const lines = body.lines || 100;
        const result = await executeCommand(env, `head -n ${lines} "${body.path}"`, 10);
        return jsonResponse({
          path: body.path,
          content: result.stdout,
          exitCode: result.exitCode
        });
      }

      // POST /file/write
      if (path === '/file/write' && method === 'POST') {
        const body = await request.json() as { path: string; content: string; append?: boolean };
        if (!body.path || body.content === undefined) {
          return jsonResponse({ error: 'Path and content required' }, 400);
        }
        const operator = body.append ? '>>' : '>';
        const escapedContent = body.content.replace(/'/g, "'\\''");
        const result = await executeCommand(env, `echo '${escapedContent}' ${operator} "${body.path}"`, 10);
        return jsonResponse({
          path: body.path,
          success: result.exitCode === 0,
          exitCode: result.exitCode
        });
      }

      // GET /system
      if (path === '/system' && method === 'GET') {
        const commands = [
          { key: 'hostname', cmd: 'hostname' },
          { key: 'uptime', cmd: 'uptime -p' },
          { key: 'memory', cmd: "free -h | grep Mem | awk '{print $3 \"/\" $2}'" },
          { key: 'disk', cmd: "df -h / | tail -1 | awk '{print $3 \"/\" $2}'" },
          { key: 'containers', cmd: 'docker ps --format "{{.Names}}: {{.Status}}" | head -10' }
        ];
        const results: Record<string, string> = {};
        for (const { key, cmd } of commands) {
          const result = await executeCommand(env, cmd, 5);
          results[key] = result.stdout.trim() || result.stderr;
        }
        return jsonResponse({ timestamp: new Date().toISOString(), ...results });
      }

      // GET /containers
      if (path === '/containers' && method === 'GET') {
        const result = await executeCommand(env, 'docker ps -a --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"', 10);
        return jsonResponse({ containers: result.stdout, exitCode: result.exitCode });
      }

      return jsonResponse({ error: 'Not found' }, 404);

    } catch (error) {
      return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  }
};
