#!/bin/bash
# Deploy SSH Executor Worker to Cloudflare
# Usage: ./deploy-cf-worker.sh <CF_API_TOKEN>

set -e

CF_API_TOKEN="${1:-$CLOUDFLARE_API_TOKEN}"
ACCOUNT_ID="9a877cdba770217082a2f914427df505"
WORKER_NAME="ssh-executor-worker"
AUTH_TOKEN=$(cat /tmp/ssh_auth_token 2>/dev/null || echo "REPLACE_ME")
COOLIFY_TOKEN="${COOLIFY_TOKEN:-REPLACE_ME}"

if [ -z "$CF_API_TOKEN" ]; then
  echo "Usage: $0 <CLOUDFLARE_API_TOKEN>"
  exit 1
fi

cd /home/claude/ssh-agent/mcp-server

echo "Deploying $WORKER_NAME to Cloudflare..."

# Create the worker script
cat > /tmp/worker.mjs << 'WORKERCODE'
const BLOCKED = [/rm\s+-rf\s+\/\s*$/i, /mkfs/i, /dd\s+if=.*of=\/dev/i];
const isBlocked = (c) => BLOCKED.some(p => p.test(c));

async function exec(env, command, timeout = 30) {
  const start = Date.now();
  if (isBlocked(command)) return { stdout: '', stderr: 'Blocked', exitCode: 1, duration: Date.now() - start };
  
  try {
    const r = await fetch(`${env.COOLIFY_URL}/api/v1/servers/0/execute`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.COOLIFY_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ command })
    });
    if (r.ok) {
      const j = await r.json();
      return { stdout: j.output || '', stderr: j.error || '', exitCode: j.exit_code ?? 0, duration: Date.now() - start };
    }
    const r2 = await fetch('https://ssh-executor.ofshore.dev/exec', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.AUTH_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ command, timeout })
    });
    if (r2.ok) return await r2.json();
    throw new Error(await r2.text());
  } catch (e) {
    return { stdout: '', stderr: String(e), exitCode: 1, duration: Date.now() - start };
  }
}

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' };
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', ...cors } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (path === '/health' || path === '/') return json({ status: 'ok', v: '1.0.0', ts: new Date().toISOString() });
    
    const auth = request.headers.get('Authorization');
    if (!auth || auth !== `Bearer ${env.AUTH_TOKEN}`) return json({ error: 'Unauthorized' }, 401);
    
    try {
      if (path === '/exec' && request.method === 'POST') {
        const b = await request.json();
        if (!b.command) return json({ error: 'Command required' }, 400);
        return json(await exec(env, b.workdir ? `cd ${b.workdir} && ${b.command}` : b.command, b.timeout || 30));
      }
      if (path === '/docker' && request.method === 'POST') {
        const b = await request.json();
        if (!b.container || !b.command) return json({ error: 'Container and command required' }, 400);
        return json(await exec(env, `docker exec ${b.workdir ? `-w "${b.workdir}"` : ''} ${b.container} ${b.command}`, 60));
      }
      if (path === '/system' && request.method === 'GET') {
        const cmds = [{ k: 'hostname', c: 'hostname' }, { k: 'uptime', c: 'uptime -p' }, { k: 'containers', c: 'docker ps --format "{{.Names}}: {{.Status}}" | head -10' }];
        const r = {};
        for (const { k, c } of cmds) { const res = await exec(env, c, 5); r[k] = res.stdout.trim() || res.stderr; }
        return json({ ts: new Date().toISOString(), ...r });
      }
      return json({ error: 'Not found' }, 404);
    } catch (e) { return json({ error: String(e) }, 500); }
  }
};
WORKERCODE

# Deploy using CF API
SCRIPT_B64=$(base64 -w0 /tmp/worker.mjs)

echo "Uploading worker..."
curl -X PUT "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/scripts/$WORKER_NAME" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: multipart/form-data" \
  -F "metadata={
    \"main_module\": \"worker.mjs\",
    \"compatibility_date\": \"2024-12-01\",
    \"bindings\": [
      {\"type\": \"plain_text\", \"name\": \"AUTH_TOKEN\", \"text\": \"$AUTH_TOKEN\"},
      {\"type\": \"plain_text\", \"name\": \"COOLIFY_URL\", \"text\": \"https://coolify.ofshore.dev\"},
      {\"type\": \"plain_text\", \"name\": \"COOLIFY_TOKEN\", \"text\": \"$COOLIFY_TOKEN\"}
    ]
  }" \
  -F "worker.mjs=@/tmp/worker.mjs;type=application/javascript+module"

echo ""
echo "Done! Worker should be at: https://ssh-executor-worker.szachmacik.workers.dev"
