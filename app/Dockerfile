# ---- Stage 1: build TypeScript ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- Stage 2: small runtime image (no TypeScript, no dev deps) ----
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# Run as non-root: KubeAid's security defaults (and most clusters) expect this
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
