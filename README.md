# 斗鱼多房间同屏推流 - 一键部署包

## 简介

把多个斗鱼直播间拼成一个网格画面，混音后推到 RTMP。包含 4 个服务：

| 服务 | 端口 | 说明 |
|---|---|---|
| nginx-rtmp | 1935 | 本地 RTMP 服务器（推本地时用） |
| stream-proxy | 8888 | 流代理：拉斗鱼源，未开播房间自动填黑场，推流不断 |
| grid-stream | - | FFmpeg 网格混流 + 推流 |
| stream-manager | 8901 | Web 管理页：推流启停、房间增删、布局、标题、音量、画质 |

代码版本：见各目录下 `VERSION` 文件（当前 1.0.0）。

## 前置条件

- 安装 Docker 和 Docker Compose
- 建议 x86_64 设备；ARM 设备可能需要替换个别镜像
- 端口 1935 / 8888 / 8901 未被占用

## 部署步骤

```bash
# 1. 解压后进入目录
cd e3-streaming-deploy

# 2. 配置推流目标（必填）
cp grid-stream/config.env.example grid-stream/config.env
# 编辑 grid-stream/config.env:
#   - 推到本地测试: RTMP_URL='rtmp://nginx-rtmp:1935/live/test'
#     然后用 VLC 打开 rtmp://设备IP:1935/live/test 看画面
#   - 推到斗鱼: 填斗鱼开播设置的 RTMP 地址+推流码
#   - ROOMS: 房间号列表(逗号分隔); ENABLED: 对应启用位(1启用/0禁用)

# 3. 一键启动
docker compose up -d --build

# 4. 访问管理页
# http://设备IP:8901
```

中文字体已内置（`grid-stream/fonts/`），画面标签开箱即用。
图片图层：把 JPG/PNG 放到 `grid-stream/images/`，管理页可叠加（见管理页说明）。

## 常用命令

```bash
docker logs grid-stream --tail 20   # 看推流状态(注意:直接 docker logs 可能卡,用 --tail)
tail -c 2000 grid-stream/logs/ffmpeg.log | tr '\r' '\n' | tail -5  # 看实时码率
docker restart grid-stream          # 重启推流(改布局/标题后生效)
docker compose down                 # 停止所有
docker compose up -d --build        # 更新代码后重建
```

## API（供脚本/弹幕指令调用）

```bash
# 切换布局 auto/grid/focus/single（改完需重启 grid-stream 生效）
curl -X POST http://设备IP:8901/api/layout \
  -H 'Content-Type: application/json' -d '{"layout":"focus"}'

# 房间启用/禁用、排序、标题、音量等见管理页源码 manager.js 中的 /api/* 接口
```

## 下一步：slot 化改造

本包是改造前的基线版本。slot 化改造（ffmpeg 输入固定为
`http://stream-proxy:8888/live/slot0`…`slot9`，换房间不重启推流）
详见随包的《推流slot化改造方案.md》，建议在这台新设备上按方案实施、
验证通过后再考虑是否回迁生产环境。

## 目录结构

```
e3-streaming-deploy/
├── docker-compose.yml
├── README.md
├── 推流slot化改造方案.md
├── nginx-rtmp/            # 使用 alfg/nginx-rtmp 官方镜像,无需本地文件
├── stream-proxy/
│   ├── Dockerfile
│   ├── proxy.js
│   └── pull_rate.conf
├── grid-stream/
│   ├── grid.sh
│   ├── entry.sh
│   ├── config.env.example
│   ├── fonts/             # 已内置 NotoSansSC
│   ├── images/            # 图片图层素材(空,自行放入)
│   └── logs/              # ffmpeg 日志(空,运行时写入)
└── stream-manager/
    ├── Dockerfile
    └── manager.js
```
