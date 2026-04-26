FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --production

COPY index.ts ./
COPY bin/ ./bin/

ENTRYPOINT ["npx", "tsx", "index.ts"]
