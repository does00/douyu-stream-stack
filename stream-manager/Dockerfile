FROM node:20-slim
RUN sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources &&     apt-get update -qq && apt-get install -y -qq docker.io curl python3-pip > /dev/null 2>&1 &&     pip3 install -q -i https://mirrors.aliyun.com/pypi/simple --timeout 60 docker-compose --break-system-packages 2>/dev/null;     rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY manager.js /app/
CMD ["node", "/app/manager.js"]
