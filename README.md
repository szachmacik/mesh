# 🔧 SSH Agent Setup for Claude - All 3 Options

Ten pakiet zawiera wszystkie 3 metody dostępu SSH dla Claude do serwera DigitalOcean.

## Architektura

```
┌─────────────────────────────────────────────────────────────────────┐
│                         CLAUDE.AI                                   │
└─────────────────┬───────────────────────────────────────────────────┘
                  │
    ┌─────────────┼─────────────┬─────────────────────┐
    │             │             │                     │
    ▼             ▼             ▼                     ▼
┌────────┐  ┌──────────┐  ┌────────────┐      ┌─────────────┐
│ Opcja 1│  │ Opcja 2  │  │  Opcja 3   │      │   Direct    │
│  MCP   │  │ brain-   │  │Claude Code │      │   Coolify   │
│ Server │  │ router   │  │   on DO    │      │     API     │
└────┬───┘  └────┬─────┘  └─────┬──────┘      └──────┬──────┘
     │           │              │                    │
     └─────┬─────┴──────────────┘                    │
           │                                         │
           ▼                                         │
    ┌──────────────┐                                 │
    │ SSH Executor │◄────────────────────────────────┘
    │   Service    │
    └──────┬───────┘
           │
           ▼
    ┌──────────────┐
    │  DigitalOcean │
    │  178.62.246.169│
    └──────────────┘
```

## 📦 Komponenty

### 1. SSH Executor Service (CORE - wymagany dla wszystkich opcji)
- **Lokalizacja**: `/mcp-server/ssh-executor-service.js`
- **Deploy**: Coolify Docker
- **Port**: 3022
- **URL**: https://ssh-executor.ofshore.dev

### 2. MCP SSH Server (Cloudflare Worker)
- **Lokalizacja**: `/mcp-server/src/index.ts`
- **Deploy**: `wrangler deploy`
- **URL**: https://ssh-mcp.ofshore.dev/mcp

### 3. SSH Bridge (Cloudflare Worker)
- **Lokalizacja**: `/mcp-server/src/ssh-bridge.ts`
- **Deploy**: `wrangler deploy -c wrangler.ssh-bridge.toml`
- **URL**: https://ssh-bridge.ofshore.dev

### 4. Brain Router Extension
- **Lokalizacja**: `/brain-router-upgrade/brain-router-ssh-extension.ts`
- **Deploy**: Merge z istniejącym brain-router

### 5. Claude Code Setup Script
- **Lokalizacja**: `/claude-code-setup/setup-claude-code.sh`
- **Deploy**: `curl -fsSL <url> | bash` na serwerze

---

## 🚀 Deployment Order

### Krok 1: Deploy SSH Executor Service (Coolify)

```bash
# 1. Utwórz nową aplikację w Coolify
# UUID: do wygenerowania
# Nazwa: ssh-executor
# Repo: https://github.com/szachmacik/mesh
# Branch: main
# Build: Dockerfile.ssh-executor

# 2. Ustaw zmienne środowiskowe w Coolify:
AUTH_TOKEN=<wygenerowany-token>
PORT=3022
MAX_TIMEOUT=300

# 3. Domains: ssh-executor.ofshore.dev
```

### Krok 2: Deploy Cloudflare Workers

```bash
cd mcp-server

# Zainstaluj dependencies
npm install

# Ustaw sekrety
wrangler secret put AUTH_TOKEN
# Wklej ten sam token co dla SSH Executor

wrangler secret put COOLIFY_TOKEN
# Wklej Coolify API token z Vault

# Deploy MCP Server
wrangler deploy

# Deploy SSH Bridge
wrangler deploy -c wrangler.ssh-bridge.toml
```

### Krok 3: Update brain-router (opcjonalnie)

```bash
# Dodaj nowe env vars do brain-router w Coolify:
SSH_EXECUTOR_URL=https://ssh-executor.ofshore.dev/exec
SSH_AUTH_TOKEN=<token>

# Merge kod z brain-router-ssh-extension.ts
```

### Krok 4: Setup Claude Code na serwerze (opcjonalnie)

```bash
ssh root@178.62.246.169
curl -fsSL https://raw.githubusercontent.com/szachmacik/mesh/main/scripts/setup-claude-code.sh | bash
```

---

## 🔑 Wymagane Sekrety

| Secret | Gdzie | Opis |
|--------|-------|------|
| `AUTH_TOKEN` | CF Workers, SSH Executor | Autoryzacja API (wygeneruj: `openssl rand -hex 32`) |
| `COOLIFY_TOKEN` | CF Workers, Vault | Coolify API token |
| `SSH_PRIVATE_KEY` | Opcjonalnie | Klucz SSH dla bezpośredniego dostępu |
| `ANTHROPIC_API_KEY` | Serwer DO | Dla Claude Code |

---

## 📡 API Reference

### SSH Executor (`/exec`)

```bash
curl -X POST https://ssh-executor.ofshore.dev/exec \
  -H "Authorization: Bearer <AUTH_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"command": "docker ps", "timeout": 30}'
```

Response:
```json
{
  "stdout": "CONTAINER ID   IMAGE...",
  "stderr": "",
  "exitCode": 0,
  "duration": 150
}
```

### MCP Server (`/mcp`)

Dostępne tools:
- `ssh_exec` - wykonaj komendę
- `ssh_read_file` - odczytaj plik
- `ssh_write_file` - zapisz plik
- `ssh_list_dir` - listuj katalog
- `docker_exec` - wykonaj w kontenerze
- `service_status` - status usług
- `system_info` - info o systemie

### Brain Router Extensions

- `POST /exec` - wykonaj komendę
- `POST /docker/exec` - wykonaj w kontenerze
- `GET /system` - info systemowe
- `POST /file/read` - odczyt pliku
- `POST /file/write` - zapis pliku

---

## 🔒 Security

1. **Blocked Commands**: Niebezpieczne komendy są blokowane:
   - `rm -rf /`
   - `mkfs`
   - `dd` na urządzenia
   - Fork bombs

2. **Auth Required**: Wszystkie endpointy wymagają Bearer token

3. **Timeout Limits**: Max 300 sekund na komendę

4. **Output Limits**: Max 1MB output

---

## 🧪 Testing

```bash
# Test SSH Executor
curl https://ssh-executor.ofshore.dev/health

# Test execute
curl -X POST https://ssh-executor.ofshore.dev/exec \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"command": "hostname"}'

# Test MCP Server
curl https://ssh-mcp.ofshore.dev/mcp \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'
```

---

## 🔧 Troubleshooting

### "Connection timeout"
- Sprawdź czy SSH Executor działa: `docker ps | grep ssh-executor`
- Sprawdź logi: `docker logs ssh-executor`

### "Unauthorized"
- Upewnij się że AUTH_TOKEN jest identyczny wszędzie
- Sprawdź header: `Authorization: Bearer <token>`

### "Command blocked"
- Komenda zawiera niebezpieczny pattern
- Sprawdź listę BLOCKED_PATTERNS

---

## 📁 File Structure

```
ssh-agent/
├── mcp-server/
│   ├── src/
│   │   ├── index.ts          # MCP SSH Server
│   │   └── ssh-bridge.ts     # SSH Bridge Worker
│   ├── ssh-executor-service.js  # Node.js SSH service
│   ├── Dockerfile.ssh-executor
│   ├── docker-compose.yml
│   ├── package.json
│   ├── tsconfig.json
│   ├── wrangler.toml
│   └── wrangler.ssh-bridge.toml
├── brain-router-upgrade/
│   └── brain-router-ssh-extension.ts
├── claude-code-setup/
│   └── setup-claude-code.sh
└── README.md
```
