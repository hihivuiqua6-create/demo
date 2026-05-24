FROM node:20-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends php-cli php-mbstring php-xml php-curl php-zip ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV NODE_ENV=production
ENV PHP_BIN=php
EXPOSE 3000
CMD ["npm","start"]
