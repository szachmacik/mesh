const http = require("http");
const fs = require("fs");
const { execSync } = require("child_process");

const PORT = process.env.PORT || 3024;
const AUTH_TOKEN = process.env.AUTH_TOKEN || "change-me";
const DOCKER_SOCKET = "/var/run/docker.sock";
const hasDockerSocket = fs.existsSync(DOCKER_SOCKET);
const VERSION = "4.0.0-pro";

console.log(`[ssh-executor-pro v${VERSION}] Starting...`);
console.log(`[ssh-executor-pro] Docker socket: ${hasDockerSocket ? "AVAILABLE ✅" : "NOT AVAILABLE ❌"}`);
console.log(`[ssh-executor-pro] Port: ${PORT}`);

function run(command, timeout = 60) {
  const start = Date.now();
  try {
    const stdout = execSync(command, {
      encoding: "utf-8",
      timeout: timeout * 1000,
      maxBuffer: 1048576,
      shell: true
    });
    return { stdout, stderr: "", exitCode: 0, duration: Date.now() - start };
  } catch (e) {
    return {
      stdout: e.stdout?.toString() || "",
      stderr: e.stderr?.toString() || e.message,
      exitCode: e.status || 1,
      duration: Date.now() - start
    };
  }
}

const server = http.createServer(async (req, res) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };

  if (req.method === "OPTIONS") {
    res.writeHead(204, headers);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  // Health check - no auth
  if (path === "/health" && req.method === "GET") {
    res.writeHead(200, headers);
    res.end(JSON.stringify({
      status: "healthy",
      version: VERSION,
      dockerSocket: hasDockerSocket,
      uptime: process.uptime(),
      timestamp: new Date().toISOString()
    }));
    return;
  }

  // Auth check
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${AUTH_TOKEN}`) {
    res.writeHead(401, headers);
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  // Parse body
  let body = {};
  if (req.method === "POST") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    try {
      body = JSON.parse(Buffer.concat(chunks).toString());
    } catch {}
  }

  try {
    // Execute command
    if (path === "/exec" && req.method === "POST") {
      const { command, timeout = 60 } = body;
      if (!command) {
        res.writeHead(400, headers);
        res.end(JSON.stringify({ error: "command required" }));
        return;
      }
      const result = run(command, Math.min(timeout, 300));
      res.writeHead(200, headers);
      res.end(JSON.stringify(result));
      return;
    }

    // Docker ps
    if (path === "/docker/ps") {
      if (!hasDockerSocket) {
        res.writeHead(200, headers);
        res.end(JSON.stringify({ error: "Docker socket not available", hasSocket: false }));
        return;
      }
      const result = run("docker ps -a --format '{{.Names}}\\t{{.Status}}\\t{{.Image}}'", 30);
      res.writeHead(200, headers);
      res.end(JSON.stringify({ ok: true, hasSocket: true, ...result }));
      return;
    }

    // Docker logs
    if (path === "/docker/logs") {
      const container = url.searchParams.get("container");
      const tail = parseInt(url.searchParams.get("tail")) || 100;
      if (!container) {
        res.writeHead(400, headers);
        res.end(JSON.stringify({ error: "container parameter required" }));
        return;
      }
      const result = run(`docker logs --tail ${tail} "${container}" 2>&1`, 30);
      res.writeHead(200, headers);
      res.end(JSON.stringify({ ok: true, container, ...result }));
      return;
    }

    // Docker control
    if (path === "/docker/control" && req.method === "POST") {
      const { action, container } = body;
      if (!action || !container) {
        res.writeHead(400, headers);
        res.end(JSON.stringify({ error: "action and container required" }));
        return;
      }
      const cmds = {
        restart: "docker restart",
        stop: "docker stop",
        start: "docker start",
        rm: "docker rm -f"
      };
      if (!cmds[action]) {
        res.writeHead(400, headers);
        res.end(JSON.stringify({ error: "Invalid action. Use: restart, stop, start, rm" }));
        return;
      }
      const result = run(`${cmds[action]} "${container}" 2>&1`, 60);
      res.writeHead(200, headers);
      res.end(JSON.stringify({ ok: result.exitCode === 0, action, container, ...result }));
      return;
    }

    // Docker compose up
    if (path === "/docker/compose/up" && req.method === "POST") {
      const { path: projectPath } = body;
      if (!projectPath) {
        res.writeHead(400, headers);
        res.end(JSON.stringify({ error: "path required" }));
        return;
      }
      // Check if path exists
      const checkPath = run(`ls -la "${projectPath}" 2>&1`, 10);
      if (checkPath.exitCode !== 0) {
        res.writeHead(400, headers);
        res.end(JSON.stringify({ error: `Path not found: ${projectPath}`, details: checkPath.stderr }));
        return;
      }
      const result = run(`cd "${projectPath}" && docker compose up -d 2>&1`, 300);
      res.writeHead(200, headers);
      res.end(JSON.stringify({ ok: result.exitCode === 0, path: projectPath, ...result }));
      return;
    }

    // Docker compose down
    if (path === "/docker/compose/down" && req.method === "POST") {
      const { path: projectPath } = body;
      if (!projectPath) {
        res.writeHead(400, headers);
        res.end(JSON.stringify({ error: "path required" }));
        return;
      }
      const result = run(`cd "${projectPath}" && docker compose down 2>&1`, 120);
      res.writeHead(200, headers);
      res.end(JSON.stringify({ ok: result.exitCode === 0, path: projectPath, ...result }));
      return;
    }

    // Find docker-compose files
    if (path === "/docker/compose/find") {
      const search = url.searchParams.get("search") || "";
      let cmd = "find /home /opt /root /data /srv -name 'docker-compose*' 2>/dev/null | head -30";
      if (search) {
        cmd = `find /home /opt /root /data /srv -name 'docker-compose*' 2>/dev/null | xargs grep -l '${search}' 2>/dev/null | head -20`;
      }
      const result = run(cmd, 60);
      res.writeHead(200, headers);
      res.end(JSON.stringify({ ok: true, search, ...result }));
      return;
    }

    // System info
    if (path === "/system") {
      const [uptime, memory, disk, containers] = await Promise.all([
        run("uptime", 5),
        run("free -h", 5),
        run("df -h / | tail -1", 5),
        run("docker ps --format '{{.Names}}' | wc -l", 5)
      ]);
      res.writeHead(200, headers);
      res.end(JSON.stringify({
        ok: true,
        version: VERSION,
        dockerSocket: hasDockerSocket,
        uptime: uptime.stdout?.trim(),
        memory: memory.stdout?.trim(),
        disk: disk.stdout?.trim(),
        runningContainers: parseInt(containers.stdout?.trim()) || 0
      }));
      return;
    }

    // API docs
    if (path === "/" && req.method === "GET") {
      res.writeHead(200, headers);
      res.end(JSON.stringify({
        name: "ssh-executor-pro",
        version: VERSION,
        dockerSocket: hasDockerSocket,
        endpoints: {
          "GET /health": "Health check (no auth)",
          "GET /": "API documentation",
          "POST /exec": "Execute shell command {command, timeout?}",
          "GET /docker/ps": "List all containers",
          "GET /docker/logs?container=&tail=": "Get container logs",
          "POST /docker/control": "Control container {action: restart|stop|start|rm, container}",
          "POST /docker/compose/up": "Docker compose up {path}",
          "POST /docker/compose/down": "Docker compose down {path}",
          "GET /docker/compose/find?search=": "Find docker-compose files",
          "GET /system": "System information"
        }
      }));
      return;
    }

    // 404
    res.writeHead(404, headers);
    res.end(JSON.stringify({ error: "Not found", path }));

  } catch (error) {
    console.error("[ssh-executor-pro] Error:", error);
    res.writeHead(500, headers);
    res.end(JSON.stringify({ error: error.message }));
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[ssh-executor-pro v${VERSION}] Running on port ${PORT}`);
  console.log(`[ssh-executor-pro] Docker socket: ${hasDockerSocket ? "AVAILABLE ✅" : "NOT AVAILABLE ❌"}`);
});
