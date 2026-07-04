FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    NODE_NO_WARNINGS=1

# server.js usa `node:sqlite` (Node 22+) y ejecuta el CLI `codeburn` para recolectar datos.
RUN npm install -g codeburn@0.9.8 \
  && npm cache clean --force

WORKDIR /app

COPY server.js ./server.js
COPY src ./src

RUN mkdir -p /app/data && chown -R node:node /app

USER node

ENV HOST=0.0.0.0 \
    PORT=8787 \
    TZ=America/Argentina/Buenos_Aires \
    CODEBURN_REFRESH_MS=300000 \
    CODEBURN_DB=/app/data/codeburn.sqlite

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
