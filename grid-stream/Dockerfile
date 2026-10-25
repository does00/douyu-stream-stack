# grid-stream 镜像版:基于官方 ffmpeg 镜像,把脚本与字体打进镜像,
# 配置与图片/日志走 volume(见 docker-compose.ghcr.yml),无需本地文件即可起服务。
FROM jrottenberg/ffmpeg:5.1-ubuntu
WORKDIR /app
COPY entry.sh grid.sh fetch_gifts.sh VERSION /app/
COPY fonts/ /app/fonts/
ENTRYPOINT ["/app/entry.sh"]
