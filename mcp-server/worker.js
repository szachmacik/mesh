const BLOCKED_PATTERNS = [/rm\s+-rf\s+\/\s*$/i, /mkfs/i, /dd\s+if=.*of=\/dev/i];

function isBlocked(command) {
  return BLOCKED_PATTERNS.some(p => p.test(command));
}

async function executeCommand(env, command, timeout = 30) {
  const startTime = Date.now();
  if (isBlocked(command)) {
    return { stdout: '', stderr: 'Command blocked', exitCode: 1, duration: Date.now() - startTime };
  }
  
  try {
    // Try Coolify execute
    const response = await fetch(`${env.COOLIFY_URL}/api/v1/servers/0/execute`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.COOLIFY_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ command })
    });
    
    if (response.ok) {
      const result = await response.json();
      return {
        stdout: result.output || result.stdout || '',
        stderr: result.error || result.stderr || '',
        exitCode: result.exit_code ?? 0,
        duration: Date.now() - startTime
      };
    }
    
    // Fallback to ssh-executor
    const execResponse = await fetch('https://ssh-executor.ofshore.dev/exec', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.AUTH_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ command, timeout })
    });
    
    if (execResponse.ok) return await execResponse.json();
    throw new Error(await execResponse.text());
  } catch (e) {
    return { stdout: '', stderr: String(e), exitCode: 1, duration: Date.now() - startTime };
  }
}

function checkAuth(request, env) {
  const auth = request.headers.get('Authorization');
  if (!auth || auth !== `Bearer ${env.AUTH_TOKEN}`) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { 
      status: 401, 
      headers: { 'Content-Type': 'application/json' }
    });
  }
  return null;
}

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') return new Response(null, { headers: cors });

    if (path === '/health' || path === '/') {
      return json({ status: 'ok', version: '1.0.0', timestamp: new Date().toISOString() });
    }

    const authError = checkAuth(request, env);
    if (authError) return authError;

    try {
      if (path === '/exec' && method === 'POST') {
        const body = await request.json();
        if (!body.command) return json({ error: 'Command required' }, 400);
        let cmd = body.command;
        if (body.workdir) cmd = `cd ${body.workdir} && ${cmd}`;
        return json(await executeCommand(env, cmd, body.timeout || 30));
      }

      if (path === '/docker' && method === 'POST') {
        const body = await request.json();
        if (!body.container || !body.command) return json({ error: 'Container and command required' }, 400);
        let cmd = `docker exec ${body.workdir ? `-w "${body.workdir}"` : ''} ${body.container} ${body.command}`;
        return json(await executeCommand(env, cmd, 60));
      }

      if (path === '/system' && method === 'GET') {
        const cmds = [
          { k: 'hostname', c: 'hostname' },
          { k: 'uptime', c: 'uptime -p' },
          { k: 'containers', c: 'docker ps --format "{{.Names}}: {{.Status}}" | head -10' }
        ];
        const r = {};
        for (const { k, c } of cmds) {
          const res = await executeCommand(env, c, 5);
          r[k] = res.stdout.trim() || res.stderr;
        }
        return json({ timestamp: new Date().toISOString(), ...r });
      }

      return json({ error: 'Not found' }, 404);
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }
};
