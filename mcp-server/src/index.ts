/**
 * SSH MCP Server for Claude.ai
 * Allows Claude to execute SSH commands on DigitalOcean server
 * Deployed as Cloudflare Worker
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

// Environment variables interface
interface Env {
  SSH_HOST: string;
  SSH_USER: string;
  SSH_PRIVATE_KEY: string;
  AUTH_TOKEN: string;
}

// SSH Command input schema
const SSHCommandSchema = z.object({
  command: z.string()
    .min(1, "Command cannot be empty")
    .max(10000, "Command too long")
    .describe("The bash command to execute on the remote server"),
  timeout: z.number()
    .int()
    .min(1)
    .max(300)
    .default(30)
    .describe("Command timeout in seconds (default: 30, max: 300)"),
  workdir: z.string()
    .optional()
    .describe("Working directory for the command (optional)")
}).strict();

type SSHCommandInput = z.infer<typeof SSHCommandSchema>;

// File operation schemas
const FileReadSchema = z.object({
  path: z.string().min(1).describe("Absolute path to the file to read"),
  lines: z.number().int().min(1).max(1000).default(100).describe("Number of lines to read (default: 100)")
}).strict();

const FileWriteSchema = z.object({
  path: z.string().min(1).describe("Absolute path to the file"),
  content: z.string().describe("Content to write to the file"),
  append: z.boolean().default(false).describe("Append instead of overwrite")
}).strict();

const DirectoryListSchema = z.object({
  path: z.string().min(1).describe("Directory path to list"),
  recursive: z.boolean().default(false).describe("List recursively"),
  maxDepth: z.number().int().min(1).max(5).default(2).describe("Max depth for recursive listing")
}).strict();

// Docker/Coolify schemas
const DockerExecSchema = z.object({
  container: z.string().min(1).describe("Container name or ID"),
  command: z.string().min(1).describe("Command to execute inside container"),
  workdir: z.string().optional().describe("Working directory inside container")
}).strict();

const ServiceStatusSchema = z.object({
  service: z.string().optional().describe("Specific service name (optional, lists all if omitted)")
}).strict();

// Create MCP server
const server = new McpServer({
  name: "ssh-mcp-server",
  version: "1.0.0"
});

// Helper: Execute SSH command via Cloudflare Worker
async function executeSSH(env: Env, command: string, timeout: number = 30): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  // Use ssh2-lite or call external SSH service
  // For Cloudflare Workers, we'll proxy through a bridge service
  
  const bridgeUrl = `https://ssh-bridge.ofshore.dev/exec`;
  
  const response = await fetch(bridgeUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.AUTH_TOKEN}`
    },
    body: JSON.stringify({
      host: env.SSH_HOST,
      user: env.SSH_USER,
      privateKey: env.SSH_PRIVATE_KEY,
      command,
      timeout
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`SSH execution failed: ${error}`);
  }

  return response.json();
}

// Tool: Execute arbitrary SSH command
server.registerTool(
  "ssh_exec",
  {
    title: "Execute SSH Command",
    description: `Execute a bash command on the remote DigitalOcean server via SSH.

This tool runs commands directly on the server (178.62.246.169) with full root access.

Args:
  - command (string): The bash command to execute
  - timeout (number): Command timeout in seconds (default: 30, max: 300)
  - workdir (string): Optional working directory

Returns:
  {
    "stdout": string,    // Standard output
    "stderr": string,    // Standard error
    "exitCode": number,  // Exit code (0 = success)
    "duration": number   // Execution time in ms
  }

Examples:
  - "List running containers" -> command: "docker ps"
  - "Check disk space" -> command: "df -h"
  - "Restart service" -> command: "systemctl restart nginx"

Security: This tool has full server access. Use responsibly.`,
    inputSchema: SSHCommandSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true
    }
  },
  async (params: SSHCommandInput, extra: { env: Env }) => {
    const startTime = Date.now();
    
    try {
      let cmd = params.command;
      if (params.workdir) {
        cmd = `cd ${params.workdir} && ${cmd}`;
      }
      
      const result = await executeSSH(extra.env, cmd, params.timeout);
      const duration = Date.now() - startTime;
      
      const output = {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        duration
      };
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify(output, null, 2)
        }],
        structuredContent: output
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  }
);

// Tool: Read file
server.registerTool(
  "ssh_read_file",
  {
    title: "Read File via SSH",
    description: `Read contents of a file on the remote server.

Args:
  - path (string): Absolute path to the file
  - lines (number): Number of lines to read (default: 100, max: 1000)

Returns file content or error message.`,
    inputSchema: FileReadSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  async (params, extra: { env: Env }) => {
    const command = `head -n ${params.lines} "${params.path}"`;
    const result = await executeSSH(extra.env, command, 10);
    
    if (result.exitCode !== 0) {
      return {
        content: [{ type: "text", text: `Error reading file: ${result.stderr}` }],
        isError: true
      };
    }
    
    return {
      content: [{ type: "text", text: result.stdout }]
    };
  }
);

// Tool: Write file
server.registerTool(
  "ssh_write_file",
  {
    title: "Write File via SSH",
    description: `Write content to a file on the remote server.

Args:
  - path (string): Absolute path to the file
  - content (string): Content to write
  - append (boolean): Append instead of overwrite (default: false)

Returns success message or error.`,
    inputSchema: FileWriteSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false
    }
  },
  async (params, extra: { env: Env }) => {
    const operator = params.append ? '>>' : '>';
    // Escape content for shell
    const escapedContent = params.content.replace(/'/g, "'\\''");
    const command = `echo '${escapedContent}' ${operator} "${params.path}"`;
    
    const result = await executeSSH(extra.env, command, 10);
    
    if (result.exitCode !== 0) {
      return {
        content: [{ type: "text", text: `Error writing file: ${result.stderr}` }],
        isError: true
      };
    }
    
    return {
      content: [{ type: "text", text: `Successfully wrote to ${params.path}` }]
    };
  }
);

// Tool: List directory
server.registerTool(
  "ssh_list_dir",
  {
    title: "List Directory via SSH",
    description: `List contents of a directory on the remote server.

Args:
  - path (string): Directory path
  - recursive (boolean): List recursively (default: false)
  - maxDepth (number): Max depth for recursive listing (default: 2)

Returns directory listing.`,
    inputSchema: DirectoryListSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  async (params, extra: { env: Env }) => {
    let command: string;
    if (params.recursive) {
      command = `find "${params.path}" -maxdepth ${params.maxDepth} -type f -o -type d | head -500`;
    } else {
      command = `ls -la "${params.path}"`;
    }
    
    const result = await executeSSH(extra.env, command, 15);
    
    return {
      content: [{ type: "text", text: result.stdout || result.stderr }]
    };
  }
);

// Tool: Docker exec
server.registerTool(
  "docker_exec",
  {
    title: "Execute Command in Docker Container",
    description: `Execute a command inside a running Docker container.

Args:
  - container (string): Container name or ID
  - command (string): Command to execute
  - workdir (string): Optional working directory inside container

Returns command output.`,
    inputSchema: DockerExecSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true
    }
  },
  async (params, extra: { env: Env }) => {
    let cmd = `docker exec`;
    if (params.workdir) {
      cmd += ` -w "${params.workdir}"`;
    }
    cmd += ` ${params.container} ${params.command}`;
    
    const result = await executeSSH(extra.env, cmd, 60);
    
    return {
      content: [{
        type: "text",
        text: result.exitCode === 0 ? result.stdout : `Error (${result.exitCode}): ${result.stderr}`
      }]
    };
  }
);

// Tool: Service status
server.registerTool(
  "service_status",
  {
    title: "Check Service Status",
    description: `Check status of Docker containers/services on the server.

Args:
  - service (string): Optional specific service name (shows all if omitted)

Returns service status information.`,
    inputSchema: ServiceStatusSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  async (params, extra: { env: Env }) => {
    let command: string;
    if (params.service) {
      command = `docker ps -a --filter "name=${params.service}" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"`;
    } else {
      command = `docker ps -a --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"`;
    }
    
    const result = await executeSSH(extra.env, command, 10);
    
    return {
      content: [{ type: "text", text: result.stdout }]
    };
  }
);

// Tool: System info
server.registerTool(
  "system_info",
  {
    title: "Get System Information",
    description: `Get comprehensive system information including CPU, memory, disk, and network stats.

Returns system metrics and health status.`,
    inputSchema: z.object({}).strict(),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  async (_params, extra: { env: Env }) => {
    const commands = [
      'echo "=== HOSTNAME ===" && hostname',
      'echo "\\n=== UPTIME ===" && uptime',
      'echo "\\n=== MEMORY ===" && free -h',
      'echo "\\n=== DISK ===" && df -h',
      'echo "\\n=== CPU ===" && top -bn1 | head -5',
      'echo "\\n=== DOCKER ===" && docker ps --format "{{.Names}}: {{.Status}}" | head -20'
    ];
    
    const result = await executeSSH(extra.env, commands.join(' && '), 30);
    
    return {
      content: [{ type: "text", text: result.stdout }]
    };
  }
);

// Export for Cloudflare Workers
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        }
      });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    const url = new URL(request.url);
    if (url.pathname !== '/mcp') {
      return new Response('Not found', { status: 404 });
    }

    // Verify auth token from request
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || authHeader !== `Bearer ${env.AUTH_TOKEN}`) {
      return new Response('Unauthorized', { status: 401 });
    }

    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true
      });

      // Inject env into tool handlers
      const serverWithEnv = server;
      
      await serverWithEnv.connect(transport);
      
      const body = await request.json();
      
      // Create a mock Express-like request/response
      const result = await transport.handleRequest(
        { body } as any,
        {
          setHeader: () => {},
          write: () => {},
          end: () => {},
          on: () => {}
        } as any,
        body
      );

      return new Response(JSON.stringify(result), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    } catch (error) {
      console.error('MCP error:', error);
      return new Response(JSON.stringify({ error: String(error) }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
};
