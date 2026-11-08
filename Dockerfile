# Runs the chat, staff desk and pickup screen in one small container.
# The app has no runtime dependencies (only Node's built-ins), so there's no npm install.
FROM node:24-slim

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
COPY tenants ./tenants

# Databases, search indexes and backups live in /data: mount a volume there to keep them.
RUN mkdir -p /data && chown node:node /data
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "src/server/main.ts"]
