FROM node:20-alpine

# Install docker CLI for container management
RUN apk add --no-cache docker-cli curl bash

WORKDIR /app

# Copy server code
COPY ssh-executor-pro.js /app/server.js

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3024/health || exit 1

EXPOSE 3024

CMD ["node", "/app/server.js"]
