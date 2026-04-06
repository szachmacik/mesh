#!/bin/bash
#
# Claude Code Setup Script for DigitalOcean Server
# Run this on the server: curl -fsSL https://raw.githubusercontent.com/szachmacik/mesh/main/scripts/setup-claude-code.sh | bash
#
# This script:
# 1. Installs Node.js 20 LTS if needed
# 2. Installs Claude Code CLI globally
# 3. Sets up tmux session for persistent Claude Code
# 4. Configures environment with API keys from Supabase Vault
#

set -e

echo "🤖 Claude Code Setup for DigitalOcean Server"
echo "============================================="

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
SUPABASE_URL="https://blgdhfcosqjzrutncbbr.supabase.co"
SUPABASE_SERVICE_KEY="${SUPABASE_SERVICE_KEY:-}"

# Check if running as root
if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}Please run as root${NC}"
  exit 1
fi

# Function to check if command exists
command_exists() {
  command -v "$1" >/dev/null 2>&1
}

# Step 1: Install Node.js 20 if needed
echo -e "\n${YELLOW}Step 1: Checking Node.js...${NC}"
if command_exists node; then
  NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
  if [ "$NODE_VERSION" -ge 18 ]; then
    echo -e "${GREEN}Node.js $(node -v) is installed and compatible${NC}"
  else
    echo "Node.js version too old, upgrading..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  fi
else
  echo "Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

# Step 2: Install tmux if needed
echo -e "\n${YELLOW}Step 2: Checking tmux...${NC}"
if command_exists tmux; then
  echo -e "${GREEN}tmux is installed${NC}"
else
  echo "Installing tmux..."
  apt-get install -y tmux
fi

# Step 3: Install Claude Code CLI
echo -e "\n${YELLOW}Step 3: Installing Claude Code CLI...${NC}"
npm install -g @anthropic-ai/claude-code
echo -e "${GREEN}Claude Code installed: $(claude --version)${NC}"

# Step 4: Create Claude Code config directory
echo -e "\n${YELLOW}Step 4: Setting up config...${NC}"
mkdir -p /root/.claude
mkdir -p /root/.config/claude

# Step 5: Create wrapper script with environment
cat > /usr/local/bin/claude-session << 'EOF'
#!/bin/bash
#
# Claude Code Session Manager
# Usage: claude-session [start|stop|attach|status]
#

SESSION_NAME="claude-code"

case "$1" in
  start)
    if tmux has-session -t $SESSION_NAME 2>/dev/null; then
      echo "Session already exists. Use 'claude-session attach' to connect."
      exit 1
    fi
    echo "Starting Claude Code session..."
    tmux new-session -d -s $SESSION_NAME
    tmux send-keys -t $SESSION_NAME "cd /root && claude" Enter
    echo "Session started. Use 'claude-session attach' to connect."
    ;;
  stop)
    if tmux has-session -t $SESSION_NAME 2>/dev/null; then
      tmux kill-session -t $SESSION_NAME
      echo "Session stopped."
    else
      echo "No session running."
    fi
    ;;
  attach)
    if tmux has-session -t $SESSION_NAME 2>/dev/null; then
      tmux attach-session -t $SESSION_NAME
    else
      echo "No session running. Use 'claude-session start' first."
      exit 1
    fi
    ;;
  status)
    if tmux has-session -t $SESSION_NAME 2>/dev/null; then
      echo "Claude Code session is running"
      tmux list-windows -t $SESSION_NAME
    else
      echo "No session running"
    fi
    ;;
  *)
    echo "Usage: claude-session [start|stop|attach|status]"
    exit 1
    ;;
esac
EOF
chmod +x /usr/local/bin/claude-session

# Step 6: Create systemd service for auto-start
cat > /etc/systemd/system/claude-code.service << 'EOF'
[Unit]
Description=Claude Code AI Assistant
After=network.target docker.service

[Service]
Type=forking
User=root
ExecStart=/usr/bin/tmux new-session -d -s claude-code 'claude'
ExecStop=/usr/bin/tmux kill-session -t claude-code
RemainAfterExit=yes
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload

# Step 7: Create API key setup script
cat > /usr/local/bin/claude-setup-keys << 'EOF'
#!/bin/bash
#
# Setup API keys for Claude Code from Supabase Vault
#

SUPABASE_URL="https://blgdhfcosqjzrutncbbr.supabase.co"

echo "Enter your Supabase service role key:"
read -s SUPABASE_KEY

if [ -z "$SUPABASE_KEY" ]; then
  echo "Key required"
  exit 1
fi

echo "Fetching API key from Vault..."

RESPONSE=$(curl -s "${SUPABASE_URL}/rest/v1/rpc/get_vault_secret" \
  -H "apikey: ${SUPABASE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"secret_name": "anthropic_api_key"}')

if echo "$RESPONSE" | grep -q "error"; then
  echo "Error fetching key: $RESPONSE"
  exit 1
fi

API_KEY=$(echo "$RESPONSE" | jq -r '.')

if [ -z "$API_KEY" ] || [ "$API_KEY" == "null" ]; then
  echo "Could not extract API key"
  exit 1
fi

# Save to Claude Code config
echo "ANTHROPIC_API_KEY=${API_KEY}" > /root/.claude/.env
echo "export ANTHROPIC_API_KEY=${API_KEY}" >> /root/.bashrc

echo "API key configured successfully!"
echo "Run 'source ~/.bashrc' or start a new session."
EOF
chmod +x /usr/local/bin/claude-setup-keys

# Step 8: Create helper aliases
cat >> /root/.bashrc << 'EOF'

# Claude Code aliases
alias cc='claude'
alias ccs='claude-session start'
alias cca='claude-session attach'
alias ccx='claude-session stop'

# Auto-complete for claude
eval "$(claude completion bash 2>/dev/null || true)"
EOF

echo ""
echo -e "${GREEN}=============================================${NC}"
echo -e "${GREEN}Claude Code Setup Complete!${NC}"
echo -e "${GREEN}=============================================${NC}"
echo ""
echo "Next steps:"
echo ""
echo "1. Set up your API key:"
echo "   ${YELLOW}claude-setup-keys${NC}"
echo ""
echo "   Or manually:"
echo "   ${YELLOW}export ANTHROPIC_API_KEY=your-key${NC}"
echo ""
echo "2. Start Claude Code:"
echo "   ${YELLOW}claude${NC}                    # Interactive mode"
echo "   ${YELLOW}claude-session start${NC}      # Background tmux session"
echo "   ${YELLOW}claude-session attach${NC}     # Attach to session"
echo ""
echo "3. Enable auto-start (optional):"
echo "   ${YELLOW}systemctl enable claude-code${NC}"
echo ""
echo "Useful commands:"
echo "   cc  - Start claude"
echo "   ccs - Start background session"
echo "   cca - Attach to session"
echo "   ccx - Stop session"
echo ""
