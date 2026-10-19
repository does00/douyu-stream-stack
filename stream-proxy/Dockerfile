FROM node:20-slim
RUN sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources &&     apt-get update -qq && apt-get install -y -qq ffmpeg > /dev/null 2>&1 &&     rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY proxy.js /app/
CMD ["node", "/app/proxy.js"]
