# GDG Games server (GDG Race, Boss Raid + the static Code-Man and CodeBreaker builds), served under /games.
# Build context is the parent "game" folder so the two static games can be copied in:
#   docker build -f GDG-Race/Dockerfile -t gdg-games .        (run from E:\gdg\game)
# or via docker-compose (service "games").
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    BASE_PATH=/games \
    CODEMAN_DIR=/srv/Code-Man \
    CODEBREAKER_DIR=/srv/CodeBreaker

WORKDIR /srv/GDG-Race
COPY GDG-Race/package.json GDG-Race/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY GDG-Race/server ./server
COPY GDG-Race/shared ./shared
COPY GDG-Race/public ./public
COPY GDG-Race/data ./data

# static games: only what the browser needs (no tests, tools, node_modules or package files)
COPY Code-Man/index.html Code-Man/manifest.webmanifest /srv/Code-Man/
COPY Code-Man/assets /srv/Code-Man/assets
COPY Code-Man/data /srv/Code-Man/data
COPY Code-Man/lib /srv/Code-Man/lib
COPY Code-Man/src /srv/Code-Man/src
COPY Code-Man/styles /srv/Code-Man/styles
COPY CodeBreaker/index.html /srv/CodeBreaker/
COPY CodeBreaker/data /srv/CodeBreaker/data

USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "server/index.js"]
