# SSH Agent Stack - Instrukcja Deploymentu

## 🔑 Wygenerowany AUTH_TOKEN
```
b554f5dce9ce925e9da21b44f288cdf402c8daabbff56fe7d7ed60fe60e771d5
```

## 📦 Repozytorium
https://github.com/szachmacik/mesh

---

## 1️⃣ Deploy SSH Executor w Coolify

### Krok 1: Utwórz nową aplikację
1. Idź do: https://coolify.ofshore.dev
2. Wybierz serwer DigitalOcean
3. Dodaj nową aplikację → GitHub → `szachmacik/mesh`
4. Ustaw:
   - **Name:** `ssh-executor`
   - **Dockerfile path:** `mcp-server/Dockerfile.ssh-executor`
   - **Domain:** `ssh-executor.ofshore.dev`
   - **Port:** `3022`

### Krok 2: Ustaw zmienne środowiskowe
```
AUTH_TOKEN=b554f5dce9ce925e9da21b44f288cdf402c8daabbff56fe7d7ed60fe60e771d5
PORT=3022
```

### Krok 3: Deploy i test
```bash
curl https://ssh-executor.ofshore.dev/health
```

---

## 2️⃣ Deploy Cloudflare Worker

### Opcja A: Przez wrangler (wymaga CF API token)
```bash
cd /home/claude/ssh-agent/mcp-server
export CLOUDFLARE_API_TOKEN="twój-token-z-cloudflare"
export COOLIFY_TOKEN="twój-coolify-token"

# Set secrets
echo "b554f5dce9ce925e9da21b44f288cdf402c8daabbff56fe7d7ed60fe60e771d5" | npx wrangler secret put AUTH_TOKEN
echo "$COOLIFY_TOKEN" | npx wrangler secret put COOLIFY_TOKEN

# Deploy
npx wrangler deploy
```

### Opcja B: Użyj gotowego skryptu
```bash
./deploy-cf-worker.sh <CLOUDFLARE_API_TOKEN>
```

### Test Worker
```bash
curl https://ssh-executor-worker.szachmacik.workers.dev/health

curl -X POST https://ssh-executor-worker.szachmacik.workers.dev/exec \
  -H "Authorization: Bearer b554f5dce9ce925e9da21b44f288cdf402c8daabbff56fe7d7ed60fe60e771d5" \
  -H "Content-Type: application/json" \
  -d '{"command": "hostname"}'
```

---

## 3️⃣ Zapisz token w Vault (Supabase)
```sql
SELECT vault.create_secret(
  'ssh_auth_token',
  'b554f5dce9ce925e9da21b44f288cdf402c8daabbff56fe7d7ed60fe60e771d5',
  'Auth token for SSH executor services'
);
```

---

## 4️⃣ (Opcjonalnie) Claude Code na serwerze
```bash
ssh root@178.62.246.169
curl -fsSL https://raw.githubusercontent.com/szachmacik/mesh/main/claude-code-setup/setup-claude-code.sh | bash
```

---

## 🔗 Endpoints po wdrożeniu

| Service | URL |
|---------|-----|
| SSH Executor Service | https://ssh-executor.ofshore.dev |
| CF Worker | https://ssh-executor-worker.szachmacik.workers.dev |
| GitHub Repo | https://github.com/szachmacik/mesh |

---

## 📋 API Reference

### POST /exec
```json
{
  "command": "docker ps",
  "timeout": 30,
  "workdir": "/opt"
}
```

### POST /docker
```json
{
  "container": "nginx",
  "command": "nginx -t"
}
```

### GET /system
Returns: hostname, uptime, containers status

### GET /health
No auth required - returns status
