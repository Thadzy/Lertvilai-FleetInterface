# ─── Stage 1: Build ──────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Vite env vars are baked into the bundle at build time.
# Pass these as build args:
#   docker build \
#     --build-arg VITE_SUPABASE_URL=http://<robot-ip>:8000 \
#     --build-arg VITE_SUPABASE_ANON_KEY=<anon-key> \
#     -t lertvilai-frontend .
ARG VITE_SUPABASE_URL=http://localhost:8000
ARG VITE_SUPABASE_ANON_KEY

ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL
ENV VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY

RUN npm run build

# ─── Stage 2: Serve ───────────────────────────────────────────────────────────
FROM nginx:alpine

# Copy built assets
COPY --from=builder /app/dist /usr/share/nginx/html

# nginx config template — env vars are substituted at container startup:
#   FLEET_GATEWAY_URL  (default: http://localhost:8080)
#   VRP_URL            (default: http://localhost:7779)
COPY nginx.conf.template /etc/nginx/templates/default.conf.template

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
