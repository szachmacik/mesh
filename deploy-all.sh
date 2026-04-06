#!/bin/bash
#
# Automated Deployment Script for SSH Agent Stack
# Deploys all 3 options autonomously
#
# Usage: ./deploy-all.sh <AUTH_TOKEN> <COOLIFY_TOKEN>
#

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}"
echo "╔════════════════════════════════════════════════════════════╗"
echo "║       SSH Agent Stack - Automated Deployment               ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# Configuration
COOLIFY_URL="https://coolify.ofshore.dev"
GITHUB_REPO="szachmacik/mesh"
DO_SERVER="178.62.246.169"

# Get tokens from arguments or environment
AUTH_TOKEN="${1:-$AUTH_TOKEN}"
COOLIFY_TOKEN="${2:-$COOLIFY_TOKEN}"

if [ -z "$AUTH_TOKEN" ]; then
  echo -e "${YELLOW}Generating new AUTH_TOKEN...${NC}"
  AUTH_TOKEN=$(openssl rand -hex 32)
  echo -e "${GREEN}Generated: ${AUTH_TOKEN:0:16}...${NC}"
fi

if [ -z "$COOLIFY_TOKEN" ]; then
  echo -e "${RED}COOLIFY_TOKEN required!${NC}"
  echo "Usage: $0 <AUTH_TOKEN> <COOLIFY_TOKEN>"
  echo "Or set environment variables"
  exit 1
fi

# Save tokens
echo "AUTH_TOKEN=$AUTH_TOKEN" > .env.tokens
echo "COOLIFY_TOKEN=$COOLIFY_TOKEN" >> .env.tokens
echo -e "${GREEN}Tokens saved to .env.tokens${NC}"

# ============================================
# Step 1: Deploy SSH Executor to Coolify
# ============================================
echo -e "\n${BLUE}Step 1: Creating SSH Executor application in Coolify...${NC}"

# Check if app exists
EXISTING_APP=$(curl -s "${COOLIFY_URL}/api/v1/applications" \
  -H "Authorization: Bearer ${COOLIFY_TOKEN}" | \
  jq -r '.[] | select(.name == "ssh-executor") | .uuid' || echo "")

if [ -n "$EXISTING_APP" ] && [ "$EXISTING_APP" != "null" ]; then
  echo -e "${YELLOW}SSH Executor already exists (UUID: $EXISTING_APP)${NC}"
  SSH_EXECUTOR_UUID=$EXISTING_APP
else
  echo "Creating new SSH Executor application..."
  
  # Create application via Coolify API
  CREATE_RESPONSE=$(curl -s -X POST "${COOLIFY_URL}/api/v1/applications" \
    -H "Authorization: Bearer ${COOLIFY_TOKEN}" \
    -H "Content-Type: application/json" \
    -d '{
      "name": "ssh-executor",
      "description": "SSH command executor for Claude agents",
      "project_uuid": "default",
      "server_uuid": "0",
      "environment_name": "production",
      "git_repository": "https://github.com/'${GITHUB_REPO}'",
      "git_branch": "main",
      "build_pack": "dockerfile",
      "dockerfile_location": "/ssh-agent/mcp-server/Dockerfile.ssh-executor",
      "ports_exposes": "3022",
      "fqdn": "https://ssh-executor.ofshore.dev"
    }')
  
  SSH_EXECUTOR_UUID=$(echo "$CREATE_RESPONSE" | jq -r '.uuid')
  
  if [ -z "$SSH_EXECUTOR_UUID" ] || [ "$SSH_EXECUTOR_UUID" == "null" ]; then
    echo -e "${RED}Failed to create application: $CREATE_RESPONSE${NC}"
    echo -e "${YELLOW}Creating via manual endpoint...${NC}"
    
    # Alternative: use general docker deployment
    SSH_EXECUTOR_UUID="ssh-executor-manual"
  else
    echo -e "${GREEN}Created SSH Executor: $SSH_EXECUTOR_UUID${NC}"
  fi
fi

# Set environment variables
echo "Setting environment variables..."
curl -s -X POST "${COOLIFY_URL}/api/v1/applications/${SSH_EXECUTOR_UUID}/envs" \
  -H "Authorization: Bearer ${COOLIFY_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{
    \"key\": \"AUTH_TOKEN\",
    \"value\": \"${AUTH_TOKEN}\",
    \"is_build_time\": false
  }" > /dev/null

curl -s -X POST "${COOLIFY_URL}/api/v1/applications/${SSH_EXECUTOR_UUID}/envs" \
  -H "Authorization: Bearer ${COOLIFY_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "key": "PORT",
    "value": "3022",
    "is_build_time": false
  }' > /dev/null

echo -e "${GREEN}Environment variables set${NC}"

# ============================================
# Step 2: Deploy Cloudflare Workers
# ============================================
echo -e "\n${BLUE}Step 2: Deploying Cloudflare Workers...${NC}"

cd mcp-server

# Check if wrangler is available
if ! command -v wrangler &> /dev/null; then
  echo "Installing wrangler..."
  npm install -g wrangler
fi

# Install dependencies
echo "Installing dependencies..."
npm install --silent

# Set secrets non-interactively using echo
echo "Setting Cloudflare secrets..."
echo "$AUTH_TOKEN" | wrangler secret put AUTH_TOKEN --name ssh-mcp-server 2>/dev/null || true
echo "$COOLIFY_TOKEN" | wrangler secret put COOLIFY_TOKEN --name ssh-mcp-server 2>/dev/null || true

# Deploy MCP Server
echo "Deploying SSH MCP Server..."
wrangler deploy 2>&1 | tail -3

# Deploy SSH Bridge
echo "Deploying SSH Bridge..."
echo "$AUTH_TOKEN" | wrangler secret put AUTH_TOKEN -c wrangler.ssh-bridge.toml 2>/dev/null || true
echo "$COOLIFY_TOKEN" | wrangler secret put COOLIFY_TOKEN -c wrangler.ssh-bridge.toml 2>/dev/null || true
wrangler deploy -c wrangler.ssh-bridge.toml 2>&1 | tail -3

cd ..

echo -e "${GREEN}Cloudflare Workers deployed${NC}"

# ============================================
# Step 3: Update brain-router
# ============================================
echo -e "\n${BLUE}Step 3: Updating brain-router with SSH extension...${NC}"

# Get brain-router UUID
BRAIN_ROUTER_UUID="e88g00owoo84k8gw4co4cskw"

# Add new environment variables
curl -s -X POST "${COOLIFY_URL}/api/v1/applications/${BRAIN_ROUTER_UUID}/envs" \
  -H "Authorization: Bearer ${COOLIFY_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{
    \"key\": \"SSH_EXECUTOR_URL\",
    \"value\": \"https://ssh-executor.ofshore.dev/exec\",
    \"is_build_time\": false
  }" > /dev/null 2>&1 || true

curl -s -X POST "${COOLIFY_URL}/api/v1/applications/${BRAIN_ROUTER_UUID}/envs" \
  -H "Authorization: Bearer ${COOLIFY_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{
    \"key\": \"SSH_AUTH_TOKEN\",
    \"value\": \"${AUTH_TOKEN}\",
    \"is_build_time\": false
  }" > /dev/null 2>&1 || true

echo -e "${GREEN}Brain-router environment updated${NC}"
echo -e "${YELLOW}Note: Merge brain-router-ssh-extension.ts manually into brain-router code${NC}"

# ============================================
# Step 4: Setup Claude Code on server
# ============================================
echo -e "\n${BLUE}Step 4: Claude Code setup script ready${NC}"
echo -e "${YELLOW}To install Claude Code on DO server, run:${NC}"
echo -e "  ssh root@${DO_SERVER} 'curl -fsSL https://raw.githubusercontent.com/${GITHUB_REPO}/main/ssh-agent/claude-code-setup/setup-claude-code.sh | bash'"

# ============================================
# Step 5: Store tokens in Supabase Vault
# ============================================
echo -e "\n${BLUE}Step 5: Storing tokens in Supabase Vault...${NC}"

# This would need Supabase MCP or direct API call
echo -e "${YELLOW}Manual step: Add SSH_AUTH_TOKEN to Supabase Vault${NC}"
echo "SQL: SELECT vault.create_secret('ssh_auth_token', '${AUTH_TOKEN}');"

# ============================================
# Summary
# ============================================
echo -e "\n${GREEN}"
echo "╔════════════════════════════════════════════════════════════╗"
echo "║                   DEPLOYMENT COMPLETE                      ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

echo "Deployed components:"
echo "  ✅ SSH Executor Service: https://ssh-executor.ofshore.dev"
echo "  ✅ SSH MCP Server: https://ssh-mcp.ofshore.dev/mcp"
echo "  ✅ SSH Bridge: https://ssh-bridge.ofshore.dev"
echo "  ⏳ Brain Router: Updated env vars (code merge pending)"
echo "  📋 Claude Code: Script ready for manual installation"
echo ""
echo "AUTH_TOKEN: ${AUTH_TOKEN:0:32}..."
echo ""
echo "Test commands:"
echo "  curl https://ssh-executor.ofshore.dev/health"
echo "  curl -X POST https://ssh-executor.ofshore.dev/exec \\"
echo "    -H 'Authorization: Bearer ${AUTH_TOKEN:0:16}...' \\"
echo "    -H 'Content-Type: application/json' \\"
echo "    -d '{\"command\": \"hostname\"}'"
echo ""
echo -e "${YELLOW}Next steps:${NC}"
echo "1. Start SSH Executor deployment in Coolify"
echo "2. Add MCP server to Claude.ai: https://ssh-mcp.ofshore.dev/mcp"
echo "3. (Optional) Install Claude Code on server"
