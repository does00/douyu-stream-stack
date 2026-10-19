# 推流代理 slot 化改造方案（stream-proxy 1.1.0）

## 目标

- ffmpeg 输入固定为 10 路：`http://<proxy>:8888/live/slot0` … `/live/slot9`
- 换房间 / 开关房间只改代理侧映射，**不重启 ffmpeg，推流不中断**
- 为"弹幕指令控制推流内容"打基础

## 现状（1.0.0）

- 路由 `GET /live/<rid>`，rid 在连接建立时固定
- 每连接独立循环：取流 → 失败 → 黑场填充 + 退避 → 重试
- 时间戳重基：每连接一个 rebaser，`newSession()` 把新会话接到输出时间线末端（`outMax + 40`）
- 黑场模板：5 秒黑画面 + 静音，启动生成一次，pacing 输出

## 改造点

### 1. slot→rid 映射存储

- `slots.json`，格式：`{"slot0":"12195609","slot1":null, … "slot9":null}`，挂载进容器，`fs.watch` 热加载
- 单一写入源：管理页、弹幕指令都走代理的 `POST /api/slots`，由代理写回 `slots.json`（避免多写冲突）

### 2. 路由

- 新增 `GET /live/slot0` … `/live/slot9`：走 slot 映射
- 保留 `GET /live/<rid>`：直连房间（兼容调试）

### 3. 连接循环改造（核心）

当前循环的 rid 是连接建立时固定的，改成每次迭代重新读取：

- 每次循环迭代开始时读 `curRid = slots[slot]`
- 全局 `slotsVersion` 计数器，映射每次变更 +1；每连接记录 `seenVersion`
- **流式传输中**：每 2 秒检查 `slots[slot] !== curRid || version 变化` → `killUpstream()`，强制循环重新评估；此时调 `rebaser.newSession()`，新源时间戳接到旧时间线末端，下游 ffmpeg 无感知
- **黑场等待中**：每个 5 秒 chunk 间隙检查 version，有变化立即跳出等待
- rid 为 null 或取流失败 → 走现有黑场 + 退避逻辑（不变）

切换延迟：流式中 ≤2 秒，黑场等待中 ≤5 秒。

### 4. 时间戳与音视频连续性

- remap / 上下播切换统一走 `killUpstream() + rebaser.newSession()`，复用现有逻辑，不新增时间戳机制
- 黑场模板自带静音，音频不断
- 下游 ffmpeg 的 `-reconnect` 参数保留，作为兜底

### 5. grid.sh 简化

- 输入固定 10 路 slot URL，不再按房间动态拼地址
- 原来的 ENABLED / 房间列表逻辑移到 slot 映射（slot 为 null 即该格子黑场）
- 布局模式（auto/grid/focus/single）保留，几何计算不变
- 代理 host 走环境变量：生产 `stream-proxy`，测试 `stream-proxy-test`

### 6. stream-manager（8901）改造

- 房间管理 UI 改成 slot 分配 UI：slot0…slot9 每个下拉选房间 / 空
- 调 `POST <proxy>/api/slots` 写映射；换房间不再需要重启推流
- `/api/layout`、标题、音量等其余接口不变

### 7. 部署与验证

- 新镜像 `douyu-stream-proxy:1.1.0`，项目 VERSION 同步 bump
- **先在测试栈（stream-proxy-test:8888）验证**：
  1. 10 路全空 → 10 格黑场，推流不断
  2. 分配房间 → 对应格子出画面
  3. 直播中 remap 换房间 → 画面切换，ffmpeg 日志无报错、不断流
  4. 房间下播 → 该格子自动转黑场；再开播 → 自动恢复
- 验证通过后切生产，GitHub 同步

### 8. 给弹幕控制的预留

- 弹幕监听服务只需要调 `POST /api/slots` 和 `POST /api/layout`，完全不用碰 ffmpeg
- 权限：只接受指定 UID 的指令（指令词与权限方案另行定）

## 不做的

- 不改推流目标 / 编码参数
- 不动 multiview（8900）的浏览器直连逻辑
