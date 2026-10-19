FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --registry=https://registry.npmmirror.com
COPY server.js ./
COPY lib/ ./lib/
COPY public/ ./public/
ENV HOST=0.0.0.0 PORT=8787
EXPOSE 8787
CMD ["node", "server.js"]
