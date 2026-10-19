#!/bin/bash
# 2026-10-19:PID 1 的 bash 默认忽略 SIGTERM,docker stop/restart 会傻等 10s 才 SIGKILL;
# 加 trap 转发给 ffmpeg 优雅退出,容器秒级停掉(否则管理页"应用"等重启接口必超前端 10s 超时)
trap 'pkill -x ffmpeg 2>/dev/null; exit 0' TERM INT
if ! command -v curl > /dev/null 2>&1; then
  apt-get update -qq 2>/dev/null && apt-get install -y -qq curl 2>/dev/null > /dev/null
fi
# 看门狗:ffmpeg 进程活着但输出停滞,视为卡死,杀掉由外层拉起
# 2026-10-18 教训:不要用 speed<0.9 判断——切换房间时速度短暂下跌属正常,误杀致断流
# 2026-10-19 教训:不要用"日志 mtime"判断——ffmpeg 即使 filter 饿死也会定时打印
#   frame= 进度行,mtime 一直在更新,永远触发不了。改判输出 time= 进度:
#   黑场填充也有正常推进的时间戳,只有真卡死时 time= 才停滞,切换房间不误杀。
#   另保留 mtime>120s 兜底:覆盖"连进度行都不打印"的深度 wedged。
WD_INTERVAL="${WATCHDOG_INTERVAL:-15}"
WD_STALL_SEC="${WATCHDOG_STALL_SEC:-45}"
WD_MTIME_SEC="${WATCHDOG_MTIME_SEC:-120}"
WD_LOG="${WATCHDOG_LOG:-/app/logs/ffmpeg.log}"
(
  last_time=""
  stalled=0
  while true; do
    sleep "$WD_INTERVAL"
    if ! pgrep -x ffmpeg > /dev/null 2>&1; then
      stalled=0; last_time=""; continue
    fi
    cur=$(tail -c 200000 "$WD_LOG" 2>/dev/null | grep -ao time=[0-9:.]* | tail -1 | cut -d= -f2)
    if [ -n "$cur" ]; then
      if [ "$cur" = "$last_time" ]; then
        stalled=$((stalled + WD_INTERVAL))
      else
        stalled=0; last_time="$cur"
      fi
    else
      # 尚无 time= 进度:用 mtime 兜底(进程活着但 120s 无任何日志才判死)
      _mtime=$(stat -c %Y "$WD_LOG" 2>/dev/null || echo 0)
      if [ $(( $(date +%s) - _mtime )) -gt "$WD_MTIME_SEC" ]; then
        stalled=$WD_STALL_SEC
      else
        continue
      fi
    fi
    if [ "$stalled" -ge "$WD_STALL_SEC" ]; then
      echo "[watchdog] 输出停滞 ${stalled}s (time=${cur:-none}),判定卡死,重启 ffmpeg" >&2
      pkill -x ffmpeg 2>/dev/null
      sleep 5
      pkill -9 -x ffmpeg 2>/dev/null
      stalled=0; last_time=""
      sleep 10
    fi
  done
) &
_backoff=5
while true; do
  # 日志轮转:ffmpeg.log 超过 50MB 只保留最后 10MB(2026-10-19,便携小主机防写满)
  if [ -f /app/logs/ffmpeg.log ] && [ "$(stat -c%s /app/logs/ffmpeg.log)" -gt 52428800 ]; then
    tail -c 10485760 /app/logs/ffmpeg.log > /app/logs/ffmpeg.log.tmp \
      && mv /app/logs/ffmpeg.log.tmp /app/logs/ffmpeg.log
  fi
  _start=$(date +%s)
  /app/grid.sh >>/app/logs/ffmpeg.log 2>&1
  _code=$?
  _dur=$(( $(date +%s) - _start ))
  echo "[entry] 推流进程退出(码 $_code, 运行 ${_dur}s), ${_backoff}s 后重启" >&2
  sleep $_backoff
  if [ "$_dur" -lt 60 ]; then
    _backoff=$(( _backoff * 2 ))
    [ "$_backoff" -gt 300 ] && _backoff=300
  else
    _backoff=5
  fi
done
