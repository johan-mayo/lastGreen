# Stage 1: Install dependencies and build
FROM node:20-alpine AS builder
WORKDIR /app

# Copy workspace root files
COPY package.json package-lock.json ./

# Copy workspace package.json files for dependency resolution
COPY packages/core/package.json ./packages/core/
COPY apps/web/package.json ./apps/web/

# Install all dependencies
RUN npm ci

# Copy source code
COPY packages/core/ ./packages/core/
COPY apps/web/ ./apps/web/
COPY tsconfig.base.json ./

# NEXT_PUBLIC_* vars are inlined at build time by Next.js
ENV NEXT_PUBLIC_BASE_PATH=/lastgreen

# Build core library first, then web app
RUN npm run build:core
RUN npm run build:web

# Stage 2: Production runner
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

# Copy the standalone output from Next.js
COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /app/apps/web/public ./apps/web/public

# Create writable data directory
RUN mkdir -p /data/.lastgreen-data

ENV LASTGREEN_DATA_DIR=/data/.lastgreen-data
ENV NEXT_PUBLIC_BASE_PATH=/lastgreen
ENV PORT=3000

EXPOSE 3000

CMD ["node", "apps/web/server.js"]
