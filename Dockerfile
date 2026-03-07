FROM node:20-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends git procps tzdata ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY scripts ./scripts
COPY .env.example ./

RUN mkdir -p /app/data /app/deployments /app/logs

EXPOSE 9876
VOLUME ["/app/data", "/app/deployments", "/app/logs"]

CMD ["npm", "start"]
