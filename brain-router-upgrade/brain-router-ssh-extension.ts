/**
 * Brain Router SSH Extension
 * Add this to existing brain-router worker to enable SSH command execution
 * 
 * New endpoints:
 *   POST /exec - Execute command on server
 *   POST /docker/exec - Execute command in Docker container
 *   GET /system - Get system info
 *   POST /file/read - Read file
 *   POST /file/write - Write file
 */

// Add these handlers to your existing brain-router

interface Env {
  // Existing brain-router env vars
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  
  // New SSH-related vars
  SSH_EXECUTOR_URL: string;  // https://ssh-executor.ofshore.dev or internal URL
  SSH_AUTH_TOKEN: string;
  COOLIFY_URL: string;
  COOLIFY_TOKEN: string;
}

interface ExecRequest {
  command: string;
  timeout?: number;
  workdir?: string;
}

interface DockerExecRequest {
  container: string;
  command: string;
  workdir?: string;
}

interface FileReadRequest {
  path: string;
  lines?: number;
}

interface FileWriteRequest {
  path: string;
  content: string;
  append?: boolean;
}

// Helper: Execute command via SSH Executor Service
async function executeCommand(env: Env, command: string, timeout: number = 30): Promise<any> {
  const url = env.SSH_EXECUTOR_URL || 'https://ssh-executor.ofshore.dev/exec';
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.SSH_AUTH_TOKEN}`
    },
    body: JSON.stringify({ command, timeout })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`SSH Executor error: ${error}`);
  }

  return response.json();
}

// Helper: Execute via Coolify API (alternative method)
async function executeViaCoolify(env: Env, command: string): Promise<any> {
  // Use Coolify's server execute endpoint
  const response = await fetch(`${env.COOLIFY_URL}/api/v1/servers/0/execute`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.COOLIFY_TOKEN}`
    },
    body: JSON.stringify({ command })
  });

  if (!response.ok) {
    // Try alternative: execute in a specific container
    return executeInContainer(env, 'ssh-executor', command);
  }

  return response.json();
}

// Helper: Execute in a Coolify-managed container
async function executeInContainer(env: Env, appUuid: string, command: string): Promise<any> {
  const response = await fetch(`${env.COOLIFY_URL}/api/v1/applications/${appUuid}/execute`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.COOLIFY_TOKEN}`
    },
    body: JSON.stringify({ command })
  });

  return response.json();
}

// ============ Route Handlers ============

// POST /exec - Execute arbitrary command
export async function handleExec(request: Request, env: Env): Promise<Response> {
  try {
    const body: ExecRequest = await request.json();
    
    if (!body.command) {
      return Response.json({ error: 'Command required' }, { status: 400 });
    }

    let cmd = body.command;
    if (body.workdir) {
      cmd = `cd ${body.workdir} && ${cmd}`;
    }

    const result = await executeCommand(env, cmd, body.timeout || 30);
    
    return Response.json(result);
  } catch (error) {
    return Response.json({ 
      error: error instanceof Error ? error.message : String(error) 
    }, { status: 500 });
  }
}

// POST /docker/exec - Execute in Docker container
export async function handleDockerExec(request: Request, env: Env): Promise<Response> {
  try {
    const body: DockerExecRequest = await request.json();
    
    if (!body.container || !body.command) {
      return Response.json({ error: 'Container and command required' }, { status: 400 });
    }

    let dockerCmd = `docker exec`;
    if (body.workdir) {
      dockerCmd += ` -w "${body.workdir}"`;
    }
    dockerCmd += ` ${body.container} ${body.command}`;

    const result = await executeCommand(env, dockerCmd, 60);
    
    return Response.json(result);
  } catch (error) {
    return Response.json({ 
      error: error instanceof Error ? error.message : String(error) 
    }, { status: 500 });
  }
}

// GET /system - Get system info
export async function handleSystemInfo(env: Env): Promise<Response> {
  try {
    const commands = [
      'hostname',
      'uptime -p',
      'free -h | grep Mem',
      'df -h / | tail -1',
      'docker ps --format "{{.Names}}: {{.Status}}" | head -20'
    ];

    const results: Record<string, string> = {};
    
    for (const cmd of commands) {
      try {
        const result = await executeCommand(env, cmd, 10);
        const key = cmd.split(' ')[0];
        results[key] = result.stdout?.trim() || result.stderr;
      } catch (e) {
        results[cmd.split(' ')[0]] = 'Error';
      }
    }

    return Response.json({
      timestamp: new Date().toISOString(),
      ...results
    });
  } catch (error) {
    return Response.json({ 
      error: error instanceof Error ? error.message : String(error) 
    }, { status: 500 });
  }
}

// POST /file/read - Read file
export async function handleFileRead(request: Request, env: Env): Promise<Response> {
  try {
    const body: FileReadRequest = await request.json();
    
    if (!body.path) {
      return Response.json({ error: 'Path required' }, { status: 400 });
    }

    const lines = body.lines || 100;
    const result = await executeCommand(env, `head -n ${lines} "${body.path}"`, 10);
    
    return Response.json({
      path: body.path,
      content: result.stdout,
      exitCode: result.exitCode
    });
  } catch (error) {
    return Response.json({ 
      error: error instanceof Error ? error.message : String(error) 
    }, { status: 500 });
  }
}

// POST /file/write - Write file
export async function handleFileWrite(request: Request, env: Env): Promise<Response> {
  try {
    const body: FileWriteRequest = await request.json();
    
    if (!body.path || body.content === undefined) {
      return Response.json({ error: 'Path and content required' }, { status: 400 });
    }

    const operator = body.append ? '>>' : '>';
    const escapedContent = body.content.replace(/'/g, "'\\''");
    const result = await executeCommand(env, `echo '${escapedContent}' ${operator} "${body.path}"`, 10);
    
    return Response.json({
      path: body.path,
      success: result.exitCode === 0,
      exitCode: result.exitCode
    });
  } catch (error) {
    return Response.json({ 
      error: error instanceof Error ? error.message : String(error) 
    }, { status: 500 });
  }
}

// ============ Integration with existing brain-router ============

/**
 * Add this to your existing brain-router's fetch handler:
 * 
 * // SSH Extension routes
 * if (path === '/exec' && method === 'POST') {
 *   return handleExec(request, env);
 * }
 * if (path === '/docker/exec' && method === 'POST') {
 *   return handleDockerExec(request, env);
 * }
 * if (path === '/system' && method === 'GET') {
 *   return handleSystemInfo(env);
 * }
 * if (path === '/file/read' && method === 'POST') {
 *   return handleFileRead(request, env);
 * }
 * if (path === '/file/write' && method === 'POST') {
 *   return handleFileWrite(request, env);
 * }
 */

// Full brain-router with SSH extension
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // CORS
    if (method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        }
      });
    }

    // Auth check for sensitive routes
    const sensitiveRoutes = ['/exec', '/docker/exec', '/file/write'];
    if (sensitiveRoutes.includes(path)) {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader || authHeader !== `Bearer ${env.SSH_AUTH_TOKEN}`) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }

    // Route handlers
    try {
      // SSH Extension routes
      if (path === '/exec' && method === 'POST') {
        return handleExec(request, env);
      }
      if (path === '/docker/exec' && method === 'POST') {
        return handleDockerExec(request, env);
      }
      if (path === '/system' && method === 'GET') {
        return handleSystemInfo(env);
      }
      if (path === '/file/read' && method === 'POST') {
        return handleFileRead(request, env);
      }
      if (path === '/file/write' && method === 'POST') {
        return handleFileWrite(request, env);
      }

      // Health check
      if (path === '/health') {
        return Response.json({
          status: 'ok',
          version: '2.0.0-ssh',
          timestamp: new Date().toISOString(),
          features: ['ssh-exec', 'docker-exec', 'file-ops']
        });
      }

      // ... existing brain-router routes ...

      return Response.json({ error: 'Not found' }, { status: 404 });

    } catch (error) {
      console.error('Brain Router error:', error);
      return Response.json({
        error: error instanceof Error ? error.message : String(error)
      }, { status: 500 });
    }
  }
};
