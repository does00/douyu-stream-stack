#!/bin/bash
# fetch_gifts.sh — 本地拉礼物总额(2026-10-20)
# 每 60s 从 GIFT_API_URL 拉各 slot 房间今日总额,写 /tmp/gift_totals.sh(原子替换)
# 部署说明:GIFT_API_URL 在 config.env 或管理页配置,是一个返回
#   {"rooms":[{"name":"主播名","total_money":123.4}]} 的接口(带 ?room=房间号)
# 未配置(空)时本脚本直接退出,礼物总额功能禁用,不产生任何副作用
set -u
CONFIG="/app/config.env"
[ -f "$CONFIG" ] && source "$CONFIG"
API="${GIFT_API_URL:-}"
API="${API%/}"
[ -z "$API" ] && exit 0
PROXY="${PROXY:-http://stream-proxy:8888}"

_rooms() {
  local _t="/tmp/slots_gift.sh" i _v _rid
  curl -s -m 8 --fail "$PROXY/api/slots/sh" -o "$_t" 2>/dev/null || return 1
  ( source "$_t" 2>/dev/null
    for i in 0 1 2 3 4 5 6 7 8 9; do
      _v="SLOT_$i"; _rid="${!_v:-}"
      [ -n "$_rid" ] && printf '%s ' "$_rid"
    done )
}

_esc() { printf '%s' "$1" | sed "s/'/'\\\\''/g"; }

while true; do
  _list=$(_rooms)
  if [ -n "$_list" ]; then
    _out="# 今日礼物总额,本地拉取 $(date '+%F %T')\n"
    for _rid in $_list; do
      _j=$(curl -s -m 8 "$API?room=$_rid" 2>/dev/null) || continue
      [ -z "$_j" ] && continue
      _name=$(printf '%s' "$_j" | sed -n 's/.*"name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
      _total=$(printf '%s' "$_j" | sed -n 's/.*"total_money"[[:space:]]*:[[:space:]]*\([0-9.]*\).*/\1/p' | head -1)
      [ -z "$_name" ] && continue
      _out="${_out}GIFT_NAME_${_rid}='$(_esc "$_name")'\n"
      _out="${_out}GIFT_TOTAL_${_rid}='${_total:-0}'\n"
    done
    printf '%b' "$_out" > /tmp/gift_totals.sh.tmp && mv /tmp/gift_totals.sh.tmp /tmp/gift_totals.sh
  fi
  sleep 60
done
