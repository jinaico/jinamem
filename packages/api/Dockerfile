FROM node:20-alpine AS base
WORKDIR /app

# Install deps
COPY package*.json ./
COPY packages/core/package.json packages/core/
COPY packages/api/package.json packages/api/
RUN npm install --ignore-scripts

# Copy source
COPY tsconfig.base.json ./
COPY packages/core packages/core
COPY packages/api packages/api

# Build dashboard if dist exists (pre-built)
COPY packages/dashboard/dist packages/dashboard/dist 2>/dev/null || true

# Build TypeScript
RUN npx tsc --project packages/core/tsconfig.json --skipLibCheck
RUN npx tsc --project packages/api/tsconfig.json --skipLibCheck

EXPOSE 3001
CMD ["node", "packages/api/dist/server.js"]
