#!/bin/bash
# 多路斗鱼同屏推流:代理 -> ffmpeg 网格 -> RTMP
# 配置从 /app/config.env 读取(管理页修改)
CONFIG="/app/config.env"
if [ -f "$CONFIG" ]; then source "$CONFIG"; fi

PROXY="${PROXY:-http://stream-proxy:8888}"
MULTIVIEW_API="${MULTIVIEW_API:-http://douyu-multiview:8900}"
RTMP="${RTMP_URL:-rtmp://nginx-rtmp:1935/live/douyu}"
ROOMS="${ROOMS:-182102,12195609,6570336,4489985}"
LAYOUT="${LAYOUT:-auto}"
# 文字标签:TEXT_LABELS=1 开关;LABELS 按房间号自定义 'rid1=文字1;rid2=文字2'(未设置则显示主播名)
# 位置:LABEL_POS 每路标签位置,TITLE_POS 全局标题位置;可选 tl左上 tr右上 bl左下 br右下 tc顶部居中 bc底部居中
# 字号:LABEL_SIZE/TITLE_SIZE 为空=自动(按格高/画面高自适应);颜色:LABEL_COLOR/TITLE_COLOR #rrggbb
TEXT_LABELS="${TEXT_LABELS:-1}"
LABEL_POS="${LABEL_POS:-bl}"
TITLE_POS="${TITLE_POS:-tc}"
TITLE_X="${TITLE_X:-0.5}"
TITLE_Y="${TITLE_Y:-0.03}"
# 分数坐标校验:0~1 的小数
valid_frac() { [[ "${1:-}" =~ ^(0(\.[0-9]+)?|1(\.0+)?)$ ]]; }
LABEL_SIZE="${LABEL_SIZE:-}"
TITLE_SIZE="${TITLE_SIZE:-}"
LABEL_COLOR="${LABEL_COLOR:-#ffffff}"
TITLE_COLOR="${TITLE_COLOR:-#ffffff}"
# 颜色标准化:#rrggbb -> 0xRRGGBB(非法值回退白色)
norm_color() {
  local c="${1:-#ffffff}"
  if [[ "$c" =~ ^#[0-9a-fA-F]{6}$ ]]; then echo "0x${c:1:6}"; else echo "0xFFFFFF"; fi
}
LABEL_FC=$(norm_color "$LABEL_COLOR")
TITLE_FC=$(norm_color "$TITLE_COLOR")
# 字体:优先用 config.env 指定的 FONT_FILE,否则自动取 fonts 目录下第一个 .otf/.ttf
if [ -n "${FONT_FILE:-}" ] && [ -f "/app/fonts/$FONT_FILE" ]; then
  FONT="/app/fonts/$FONT_FILE"
else
  FONT=$(ls /app/fonts/*.otf /app/fonts/*.ttf 2>/dev/null | head -1)
  [ -z "$FONT" ] && FONT="/app/fonts/NotoSansSC-Regular.otf"
fi
# 输出参数:从 config.env 读取,带默认值
W=1280; H=720
BITRATE="${BITRATE:-4000k}"
FPS="${FPS:-25}"
if ! [[ "$FPS" =~ ^[0-9]+$ ]] || [ "$FPS" -lt 1 ] || [ "$FPS" -gt 120 ]; then FPS=25; fi
# 分辨率选项:720p/1080p
RES="${RES:-720p}"
if [ "$RES" = "1080p" ]; then W=1920; H=1080; else W=1280; H=720; fi
# 码率数字部分用于 maxrate/bufsize
# 统一加 k 后缀,防止 4000 被当成 4000bps
if [[ "$BITRATE" =~ ^[0-9]+$ ]]; then BITRATE="${BITRATE}k"; fi
BR_NUM="${BITRATE%k}"
if ! [[ "$BR_NUM" =~ ^[0-9]+$ ]]; then BR_NUM=4000; BITRATE="4000k"; fi

IFS=',' read -ra VOLARR0 <<< "${VOLUMES:-}"
# 自定义标签解析: 'rid=文字;rid=文字'(分号是分隔符,标签里不能含分号,管理页保存时已过滤)
declare -A LABEL_MAP
if [ -n "${LABELS:-}" ]; then
  IFS=';' read -ra _LBS <<< "$LABELS"
  for _e in "${_LBS[@]}"; do
    _k="${_e%%=*}"; _v="${_e#*=}"
    if [[ "$_k" =~ ^[0-9]+$ ]] && [ -n "$_v" ]; then LABEL_MAP["$_k"]="$_v"; fi
  done
fi
# ---- slot 化输入:固定 10 路,房间分配由代理侧映射决定 ----
# 换房间/开关房间只调代理 POST /api/slots,不再重启推流
# /api/slots/sh 输出 SLOT_0='rid'……(空 slot 为 '')
_slots_tmp="/tmp/slots_api.sh"
if curl -s -m 8 --fail "$PROXY/api/slots/sh" -o "$_slots_tmp" 2>/dev/null; then
  # shellcheck disable=SC1090
  source "$_slots_tmp"
else
  echo "[grid] 取 slot 映射失败,10 路全空(黑场)" >&2
fi
SLOT_RIDS=()
FVOLS=()
# INPUTS 用 bash 数组(2026-10-15:字符串裸展开遇空格文件名会炸;数组展开更安全)
# 2026-10-18 slot 改造:只拉有房间的 slot,空 slot 不占格子不显示(N=实际房间数)
declare -a INPUTS=()
NAMES=()
SLOT_RIDS=()
FVOLS=()
for ((i=0;i<9;i++)); do
  _sv="SLOT_$i"
  _rid="${!_sv:-}"
  [ -z "$_rid" ] && continue
  SLOT_RIDS+=("$_rid")
  INPUTS+=( -rw_timeout 15000000 -reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 10 -i "$PROXY/live/slot$i" )
  INFO=$(curl -m 5 -s "$MULTIVIEW_API/api/room?rid=$_rid" 2>/dev/null)
  nm=$(echo "$INFO" | grep -o '"name":"[^"]*"' | head -1 | cut -d'"' -f4)
  [ -z "$nm" ] && nm=$(echo "$INFO" | grep -o '"nickname":"[^"]*"' | head -1 | cut -d'"' -f4)
  [ -z "$nm" ] && nm=$(echo "$INFO" | grep -o '"uname":"[^"]*"' | head -1 | cut -d'"' -f4)
  [ -z "$nm" ] && nm="$_rid"
  NAMES+=("$nm")
  _v="${VOLARR0[$i]:-1.0}"
  if ! [[ "$_v" =~ ^[0-9]*\.?[0-9]+$ ]]; then _v="1.0"; fi
  FVOLS+=("$_v")
done
N=${#SLOT_RIDS[@]}
if [ "$N" -eq 0 ]; then
  # 全空:保留一路黑场,不断流
  INPUTS+=( -rw_timeout 15000000 -reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 10 -i "$PROXY/live/slot0" )
  SLOT_RIDS+=("")
  NAMES+=("黑场")
  FVOLS+=("1.0")
  N=1
fi
# ---- 图片图层(8901 管理页图层编辑器):先收集有效图层,overlay 在 build_filter 之后统一加 ----
# /api/layers/sh 输出 IMAGE_{i}_{SRC,X,Y,W,H} 与 IMAGE_COUNT;
# x/y 为 0~1 画面分数坐标,w/h 为像素(0=保持原尺寸)
# 旧坑(2026-10-15):`cmd | while read` 的 while 跑在管道子 shell 里,
# INPUTS 的追加一出循环就丢了,ffmpeg 只拿到直播输入 → Invalid file index。
# 现全部在主 shell 里做:数组追加 + 有效图层先收集再统一编号,缺失文件跳过不占序号,索引不错位。
IMAGE_COUNT=0
_layers_tmp="/tmp/layers_api.sh"
if curl -s -m 8 --fail "http://stream-manager:8901/api/layers/sh" -o "$_layers_tmp" 2>/dev/null; then
  # shellcheck disable=SC1091
  . "$_layers_tmp"
fi
[[ "${IMAGE_COUNT:-0}" =~ ^[0-9]+$ ]] || IMAGE_COUNT=0
declare -a IMG_V=() IMG_X=() IMG_Y=() IMG_S=()
_vidx=$N
for ((i=0;i<IMAGE_COUNT;i++)); do
  _k="IMAGE_${i}_SRC"; _src="${!_k:-}"
  if [ -z "$_src" ] || [ ! -f "/app/images/$_src" ]; then
    [ -n "$_src" ] && echo "[grid] 图片层 $i 缺失,跳过: $_src" >&2
    continue
  fi
  _k="IMAGE_${i}_X"; _ix="${!_k:-0}"
  _k="IMAGE_${i}_Y"; _iy="${!_k:-0}"
  _k="IMAGE_${i}_SCALE"; _isc="${!_k:-1.0}"
  valid_frac "$_ix" || _ix=0
  valid_frac "$_iy" || _iy=0
  # 图片过大每秒解码25次会吃满CPU:自动缩到800px以内再用
  _img_src="/app/images/$_src"
  _iw0=$(ffprobe -hide_banner -v error -show_entries stream=width -of csv=p=0 "$_img_src" 2>/dev/null | head -1)
  _ih0=$(ffprobe -hide_banner -v error -show_entries stream=height -of csv=p=0 "$_img_src" 2>/dev/null | head -1)
  # 坏图/ffprobe 读不出尺寸:跳过该图层,避免拼出非法 scale=: 导致 ffmpeg 启动崩溃死循环
  if ! [[ "$_iw0" =~ ^[0-9]+$ ]] || ! [[ "$_ih0" =~ ^[0-9]+$ ]] || [ "$_iw0" -lt 1 ] || [ "$_ih0" -lt 1 ]; then
    echo "[grid] 警告:图片 $_src 损坏或无法识别尺寸,已跳过该图层" >&2
    continue
  fi
  if { [ "$_iw0" -gt 800 ] || [ "$_ih0" -gt 800 ]; }; then
    mkdir -p /tmp/img_small
    _small="/tmp/img_small/$_src"
    if [ ! -f "$_small" ]; then
      ffmpeg -hide_banner -v error -y -i "$_img_src" -vf "scale=800:800:force_original_aspect_ratio=decrease" "$_small" 2>/dev/null
    fi
    [ -f "$_small" ] && _img_src="$_small" && echo "[grid] 图片过大已自动压缩: $_src (${_iw0}x${_ih0})" >&2
  fi
  INPUTS+=( -re -loop 1 -framerate "$FPS" -i "$_img_src" )
  IMG_V+=( "$_vidx" )
  echo "[grid] 图片输入[$i]: $_src (input $_vidx)" >&2
  _vidx=$((_vidx+1))
  IMG_X+=( "$_ix" ); IMG_Y+=( "$_iy" )
  _sc=""
  if ! [[ "$_isc" =~ ^[0-9]*\.?[0-9]+$ ]]; then _isc=1.0; fi
  if [ "$(awk "BEGIN{print ($_isc<=0||$_isc>8)}")" -eq 1 ]; then _isc=1.0; fi
  _tw=$(awk "BEGIN{print int($_iw0*$_isc)}"); _th=$(awk "BEGIN{print int($_ih0*$_isc)}")
  [ "$_tw" -lt 1 ] && _tw=1; [ "$_th" -lt 1 ] && _th=1
  _sc="scale=${_tw}:${_th}"
  IMG_S+=( "$_sc" )
done
NIMG=${#IMG_V[@]}
# 文字标签:自定义优先,未设置则用主播名;写成 textfile 避免转义问题
# 2026-10-19:drawtext reload=1 每帧重载文件吃 70% CPU(speed 0.75x 卡顿),改走独立透明覆盖层;
# 主滤镜不画标签(SKIP_LABELS=1),覆盖层由后台一次性 ffmpeg 每 60s 渲染,经 FIFO 以 rawvideo 喂给主 ffmpeg 做 overlay
write_label_files() {
  mkdir -p /tmp/labels
  [ -f /tmp/gift_totals.sh ] && source /tmp/gift_totals.sh
  local _gen=1 _gr
  _gr=$(curl -s -m 5 http://stream-manager:8901/api/gift-labels 2>/dev/null)
  case "$_gr" in *'"enabled":false'*) _gen=0;; esac
  local i rid lb _gtv
  for ((i=0;i<N;i++)); do
    rid="${SLOT_RIDS[$i]}"
    lb="${LABEL_MAP[$rid]:-}"
    [ -z "$lb" ] && lb="${NAMES[$i]}"
    [ -z "$lb" ] && lb="$rid"
    _gtv="GIFT_TOTAL_$rid"
    if [ "$_gen" = "1" ] && [ -n "${!_gtv:-}" ]; then lb="$lb"$'\n'"今日 ¥${!_gtv}"; fi
    printf '%s' "$lb" > "/tmp/labels/label_$i.txt"
  done
}
if [ "$TEXT_LABELS" = "1" ] && [ -f "$FONT" ]; then
  LABELS_ON=1
else
  LABELS_ON=0
  [ "$TEXT_LABELS" = "1" ] && echo "[grid] 字体缺失,跳过文字标签" >&2
fi

# 每路音量: FVOLS 与 RIDS 对齐(过滤后),默认 1.0
AF=""
AIN=""
for ((i=0;i<N;i++)); do
  v="${FVOLS[$i]:-1.0}"
  AF="$AF[$i:a]volume=$v[a$i];"
  AIN="$AIN[a$i]"
done
if [ "$LAYOUT" = "single" ]; then
  AFILTER="[0:a]anull[a]"
else
  AFILTER="${AF}${AIN}amix=inputs=$N:duration=longest:dropout_transition=2[a]"
fi

# 文字标签滤镜片段:$1=标签序号 $2=格高(字号按格高自适应)
# 位置 LABEL_POS: tl左上 tr右上 bl左下 br右下 tc顶部居中 bc底部居中
label_xy() {
  case "${1:-bl}" in
    tl) echo "12:12";;
    tr) echo "w-text_w-12:12";;
    br) echo "w-text_w-12:h-th-12";;
    tc) echo "(w-text_w)/2:12";;
    bc) echo "(w-text_w)/2:h-th-12";;
    *)  echo "12:h-th-12";; # bl
  esac
}
dt_filter() {
  [ "$LABELS_ON" = "1" ] || return 0
  [ "$SKIP_LABELS" = "1" ] && return 0  # 2026-10-19:主滤镜不画标签(走独立覆盖层),drawtext reload=1 每帧重载吃 70% CPU
  local fs
  if [[ "$LABEL_SIZE" =~ ^[0-9]+$ ]] && [ "$LABEL_SIZE" -ge 10 ] && [ "$LABEL_SIZE" -le 72 ]; then
    fs=$LABEL_SIZE
  else
    fs=$(( ${2:-360} / 15 )); [ "$fs" -lt 16 ] && fs=16; [ "$fs" -gt 44 ] && fs=44
  fi
  [ -z "$fs" ] && fs=24
  local bw=$(( fs / 3 )); [ "$bw" -lt 4 ] && bw=4
  local _xy=$(label_xy "$LABEL_POS")
  local _x=${_xy%%:*} _y=${_xy#*:}
  printf ',drawtext=fontfile=%s:textfile=/tmp/labels/label_%s.txt:fontsize=%s:fontcolor=%s:box=1:boxcolor=0x000000B0:boxborderw=%s:x=%s:y=%s' "$FONT" "$1" "$fs" "$LABEL_FC" "$bw" "$_x" "$_y"
}

build_filter() {
  local mode=$1 n=$2
  local vf=""
  # 2026-10-19:田字格只定义到 4 路,n>4 回退 auto 密集表
  if [ "$mode" = "grid" ] && [ "$n" -gt 4 ]; then mode=auto; fi
  if [ "$mode" = "single" ] || [ "$n" -eq 1 ]; then
    vf="[0:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2$(dt_filter 0 $H)[v]"
  elif [ "$mode" = "focus" ]; then
    # 2026-10-19:格子必须无缝铺满整幅画布,否则 xstack 未覆盖区域显示绿块(ffmpeg 5.1 无 fillcolor)
    # 左列主画面占 3/4 宽 x 全高;右列小窗纵向无缝铺满(各自 pad 黑边,无间隙无边距)
    local main_w=$((W*3/4)) col_w=$((W-main_w))
    vf="[0:v]scale=${main_w}:${H}:force_original_aspect_ratio=decrease,pad=${main_w}:${H}:(ow-iw)/2:(oh-ih)/2$(dt_filter 0 $H)[v0]"
    local nsmall=$((n-1)) layout="" y=0
    for ((i=1;i<n;i++)); do
      local ch=$((H/nsmall))
      if [ "$i" -eq "$((n-1))" ]; then ch=$((H-y)); fi  # 最后一个吃掉余数
      vf="$vf;[$i:v]scale=${col_w}:${ch}:force_original_aspect_ratio=decrease,pad=${col_w}:${ch}:(ow-iw)/2:(oh-ih)/2$(dt_filter $i $ch)[v$i]"
      layout="$layout|${main_w}_${y}"; y=$((y+ch))
    done
    vf="$vf;[v0]"
    for ((i=1;i<n;i++)); do vf="$vf[v$i]"; done
    vf="${vf}xstack=inputs=$n:layout=0_0${layout},scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2[v]"
  elif [ "$mode" = "side" ]; then
    # 2026-10-19:左右并排——固定 2 列,奇数路时最后一格占满整行宽(无缝无绿块)
    local rows=$(( (n+1)/2 ))
    local cw=$((W/2)) ch=$((H/rows))
    local pos=""
    for ((i=0;i<n;i++)); do
      local col=$((i%2)) row=$((i/2))
      local ww hh x y
      if [ "$row" -eq "$((rows-1))" ] && [ "$((n%2))" -eq 1 ]; then
        ww=$W; x=0
      else
        ww=$cw; x=$((col*cw))
        if [ "$col" -eq 1 ]; then ww=$((W-cw)); fi
      fi
      hh=$ch; y=$((row*ch))
      if [ "$row" -eq "$((rows-1))" ]; then hh=$((H-row*ch)); fi
      vf="$vf;[$i:v]scale=$ww:$hh:force_original_aspect_ratio=decrease,pad=$ww:$hh:(ow-iw)/2:(oh-ih)/2$(dt_filter $i $hh)[v$i]"
      pos="$pos|${x}_${y}"
    done
    vf="${vf:1};"
    for ((i=0;i<n;i++)); do vf="$vf[v$i]"; done
    vf="${vf}xstack=inputs=$n:layout=${pos:1},scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2[v]"
  elif [ "$mode" = "stack" ]; then
    # 2026-10-19:上下并排——固定 2 行,奇数路时最后一格占满整列高(无缝无绿块)
    local cols=$(( (n+1)/2 ))
    local cw=$((W/cols)) ch=$((H/2))
    local pos=""
    for ((i=0;i<n;i++)); do
      local col=$((i/2)) row=$((i%2))
      local ww hh x y
      ww=$cw; x=$((col*cw))
      if [ "$col" -eq "$((cols-1))" ]; then ww=$((W-col*cw)); fi
      if [ "$col" -eq "$((cols-1))" ] && [ "$((n%2))" -eq 1 ]; then
        hh=$H; y=0
      else
        hh=$ch; y=$((row*ch))
        if [ "$row" -eq 1 ]; then hh=$((H-ch)); fi
      fi
      vf="$vf;[$i:v]scale=$ww:$hh:force_original_aspect_ratio=decrease,pad=$ww:$hh:(ow-iw)/2:(oh-ih)/2$(dt_filter $i $hh)[v$i]"
      pos="$pos|${x}_${y}"
    done
    vf="${vf:1};"
    for ((i=0;i<n;i++)); do vf="$vf[v$i]"; done
    vf="${vf}xstack=inputs=$n:layout=${pos:1},scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2[v]"
  elif [ "$mode" = "grid" ]; then
    # 2026-10-19:田字格——n=4 标准 2x2;n=3 上二下一(下一占整行宽);n=2 左右并排;n>4 已回退 auto
    local cols=2 rows=2
    if [ "$n" -eq 2 ]; then cols=2; rows=1; fi
    local cw=$((W/cols)) ch=$((H/rows))
    local pos=""
    for ((i=0;i<n;i++)); do
      local col=$((i%cols)) row=$((i/cols))
      local ww hh x y
      if [ "$n" -eq 3 ] && [ "$i" -eq 2 ]; then
        ww=$W; hh=$((H-ch)); x=0; y=$ch
      else
        ww=$cw; hh=$ch; x=$((col*cw)); y=$((row*ch))
        if [ "$col" -eq "$((cols-1))" ]; then ww=$((W-col*cw)); fi
        if [ "$row" -eq "$((rows-1))" ]; then hh=$((H-row*ch)); fi
      fi
      vf="$vf;[$i:v]scale=$ww:$hh:force_original_aspect_ratio=decrease,pad=$ww:$hh:(ow-iw)/2:(oh-ih)/2$(dt_filter $i $hh)[v$i]"
      pos="$pos|${x}_${y}"
    done
    vf="${vf:1};"
    for ((i=0;i<n;i++)); do vf="$vf[v$i]"; done
    vf="${vf}xstack=inputs=$n:layout=${pos:1},scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2[v]"
  elif [ "$mode" = "pip" ]; then
    # 2026-10-19:画中画——第 0 路全屏为底,小窗全部排进右下 1/4 象限(密集表,无缝无绿块)
    # 注意:小窗与全屏底在 xstack 里重叠,各路 SAR 必须一致(setsar=1),
    # 否则 scale 的 force_original_aspect_ratio 会产生分数 SAR(如 640/639),触发 xstack 重配失败
    vf="[0:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,setsar=1,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2$(dt_filter 0 $H)[v0]"
    local m=$((n-1)) mc=2 mr=2
    if [ "$m" -eq 1 ]; then mc=1; mr=1
    elif [ "$m" -eq 2 ]; then mc=2; mr=1
    elif [ "$m" -eq 3 ]; then mc=3; mr=1
    elif [ "$m" -eq 4 ]; then mc=2; mr=2
    elif [ "$m" -eq 5 ]; then mc=5; mr=1
    elif [ "$m" -eq 6 ]; then mc=3; mr=2
    elif [ "$m" -eq 7 ]; then mc=7; mr=1
    elif [ "$m" -eq 8 ]; then mc=4; mr=2
    elif [ "$m" -eq 9 ]; then mc=3; mr=3
    else mc=5; mr=2; fi
    local ox=$((W/2)) oy=$((H/2))
    local qw=$(((W-ox)/mc)) qh=$(((H-oy)/mr))
    local pos=""
    for ((i=1;i<n;i++)); do
      # 注意:同一条 local 里后声明的变量看不到先声明的(实测 col 会用上轮的 j),必须分开写
      local j=$((i-1))
      local col=$((j%mc)) row=$((j/mc))
      local ww=$qw hh=$qh
      if [ "$col" -eq "$((mc-1))" ]; then ww=$((W-ox-col*qw)); fi
      if [ "$row" -eq "$((mr-1))" ]; then hh=$((H-oy-row*qh)); fi
      local x=$((ox+col*qw)) y=$((oy+row*qh))
      vf="$vf;[$i:v]scale=$ww:$hh:force_original_aspect_ratio=decrease,setsar=1,pad=$ww:$hh:(ow-iw)/2:(oh-ih)/2$(dt_filter $i $hh)[v$i]"
      pos="$pos|${x}_${y}"
    done
    vf="$vf;[v0]"
    for ((i=1;i<n;i++)); do vf="$vf[v$i]"; done
    # 注意:xstack 输出已是精确 W×H(v0 全屏打底),此处不能再跟 scale(反向协商会冲掉小窗尺寸导致 pad 重配失败)
    vf="${vf}xstack=inputs=$n:layout=0_0${pos}[v]"
  else
    local cols=2 rows=2
    # 2026-10-18:布局必须无空格子,否则 xstack 空单元显示绿块(ffmpeg 5.1 无 fillcolor)
    if [ "$n" -eq 1 ]; then cols=1; rows=1
    elif [ "$n" -eq 2 ]; then cols=2; rows=1
    elif [ "$n" -eq 3 ]; then cols=3; rows=1
    elif [ "$n" -eq 4 ]; then cols=2; rows=2
    elif [ "$n" -eq 5 ]; then cols=5; rows=1
    elif [ "$n" -eq 6 ]; then cols=3; rows=2
    elif [ "$n" -eq 7 ]; then cols=7; rows=1
    elif [ "$n" -eq 8 ]; then cols=4; rows=2
    elif [ "$n" -eq 9 ]; then cols=3; rows=3
    elif [ "$n" -eq 10 ]; then cols=5; rows=2
    else cols=4; rows=3; fi
    local cw=$((W/cols)) ch=$((H/rows))
    local pos=""
    for ((i=0;i<n;i++)); do
      local col=$((i%cols)) row=$((i/cols))
      # 2026-10-19:末列/末行吃掉取整余数,杜绝右/下边缘绿边(如 1280/3 取整漏 2px)
      local ww=$cw hh=$ch
      if [ "$col" -eq "$((cols-1))" ]; then ww=$((W-col*cw)); fi
      if [ "$row" -eq "$((rows-1))" ]; then hh=$((H-row*ch)); fi
      local x=$((col*cw)) y=$((row*ch))
      vf="$vf;[$i:v]scale=$ww:$hh:force_original_aspect_ratio=decrease,pad=$ww:$hh:(ow-iw)/2:(oh-ih)/2$(dt_filter $i $hh)[v$i]"
      pos="$pos|${x}_${y}"
    done
    vf="${vf:1};"
    for ((i=0;i<n;i++)); do vf="$vf[v$i]"; done
    vf="${vf}xstack=inputs=$n:layout=${pos:1},scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2[v]"
  fi
  echo "$vf"
}

# 主滤镜:跳过每路 drawtext(省 CPU,标签走独立覆盖层)
SKIP_LABELS=1
VFILTER=$(build_filter "$LAYOUT" "$N")
SKIP_LABELS=0

# 图片 overlay:在网格之后、标题之前(标题最后盖在最上层)
# 图层列表越靠上越靠前,FFmpeg 从下往上叠,故倒序叠加让第 0 层在最上
if [ "$NIMG" -gt 0 ]; then
  _segs=( "${VFILTER%\[v]}[vbase]" )
  _in="vbase"
  for ((i=NIMG-1;i>=0;i--)); do
    _ov="[${IMG_V[$i]}:v]"
    if [ -n "${IMG_S[$i]}" ]; then
      _segs+=( "[${IMG_V[$i]}:v]${IMG_S[$i]}[img$i]" )
      _ov="[img$i]"
    fi
    if [ "$i" -eq 0 ]; then _ol="[v]"; else _ol="[vimg$i]"; fi
    _segs+=( "[${_in}]${_ov}overlay=x=W*${IMG_X[$i]}:y=H*${IMG_Y[$i]}${_ol}" )
    _in="vimg$i"
  done
  _oldifs="$IFS"; IFS=';'; VFILTER="${_segs[*]}"; IFS="$_oldifs"
  unset _segs _in _ov _ol _oldifs
fi

# 多标题: TITLE_COUNT 个独立标题,每个有文字/位置/字号/颜色/滚动/速度
# TITLE_{i}_TEXT 为空则跳过;与每路文字标签相互独立;最多 5 个
TITLE_COUNT="${TITLE_COUNT:-0}"
# 兼容旧版单标题:未设置 TITLE_COUNT 但有 GLOBAL_TEXT 时迁移为第 0 个
if [ "$TITLE_COUNT" = "0" ] && [ -n "${GLOBAL_TEXT:-}" ]; then
  TITLE_COUNT=1
  TITLE_0_TEXT="$GLOBAL_TEXT"
  TITLE_0_POS="${TITLE_POS:-tc}"
  TITLE_0_SIZE="${TITLE_SIZE:-}"
  TITLE_0_COLOR="${TITLE_COLOR:-#ffffff}"
  TITLE_0_SCROLL="${TITLE_SCROLL:-1}"
  TITLE_0_SPEED="${TITLE_SPEED:-120}"
  [ -n "${TITLE_X:-}" ] && TITLE_0_X="$TITLE_X"
  [ -n "${TITLE_Y:-}" ] && TITLE_0_Y="$TITLE_Y"
fi
[ "$TITLE_COUNT" -gt 5 ] && TITLE_COUNT=5
for (( _ti=TITLE_COUNT-1; _ti>=0; _ti-- )); do
  _k="TITLE_${_ti}_TEXT"; _ttext="${!_k}"
  [ -z "$_ttext" ] && continue
  # config.env 里换行存为字面 \n,转回真实换行
  _ttext="${_ttext//\\n/$'\n'}"
  [ -f "$FONT" ] || continue
  mkdir -p /tmp/labels
  _k="TITLE_${_ti}_SCROLL"; _tscroll="${!_k:-1}"
  _k="TITLE_${_ti}_SPEED"; _tspeed="${!_k:-120}"
  _k="TITLE_${_ti}_POS"; _tpos="${!_k:-tc}"
  _k="TITLE_${_ti}_SIZE"; _tsize="${!_k}"
  _k="TITLE_${_ti}_COLOR"; _tcolor="${!_k:-#ffffff}"
  _k="TITLE_${_ti}_X"; _txf="${!_k}"
  _k="TITLE_${_ti}_Y"; _tyf="${!_k}"
  if [[ "$_tsize" =~ ^[0-9]+$ ]] && [ "$_tsize" -ge 12 ] && [ "$_tsize" -le 96 ]; then
    _gfs=$_tsize
  else
    _gfs=$(( H / 18 )); [ "$_gfs" -lt 20 ] && _gfs=20; [ "$_gfs" -gt 54 ] && _gfs=54
  fi
  _gbw=$(( _gfs / 3 )); [ "$_gbw" -lt 6 ] && _gbw=6
  _tfc=$(norm_color "$_tcolor")
  if [ "$_tpos" = "custom" ] && valid_frac "$_txf" && valid_frac "$_tyf"; then
    _tx="w*$_txf"; _ty="h*$_tyf"
  else
    _tp="$_tpos"; [ "$_tp" = "custom" ] && _tp="tc"
    _txy=$(label_xy "$_tp"); _tx=${_txy%%:*}; _ty=${_txy#*:}
    [ "$_ty" = "12" ] && _ty=16
  fi
  _tfile="/tmp/labels/gtitle_${_ti}.txt"
  # 含换行的多行标题不跑马灯,直接静态显示
  case "$_ttext" in *$'\n'*) _tscroll="0";; esac
  if [ "$_tscroll" = "1" ]; then
    if ! [[ "$_tspeed" =~ ^[0-9]+$ ]] || [ "$_tspeed" -lt 20 ]; then _tspeed=120; fi
    [ "$_tspeed" -gt 500 ] && _tspeed=500
    _sep="   •   "
    _unit="${_ttext}${_sep}"
    _ulen=${#_unit}; [ "$_ulen" -eq 0 ] && _ulen=1
    _uest=$(( _ulen * _gfs / 2 )); [ "$_uest" -eq 0 ] && _uest=1
    _nrep=$(( W / _uest + 3 ))
    [ "$_nrep" -lt 4 ] && _nrep=4
    [ "$_nrep" -gt 32 ] && _nrep=32
    _txt=""
    for ((i=0;i<_nrep;i++)); do _txt="${_txt}${_unit}"; done
    printf '%s' "$_txt" > "$_tfile"
    _tx="-mod(n*${_tspeed}/${FPS}\\,text_w/${_nrep})"
  else
    printf '%b' "$_ttext" > "$_tfile"
  fi
  VFILTER="${VFILTER%\[v]}[vbase];[vbase]drawtext=fontfile=$FONT:textfile=$_tfile:fontsize=$_gfs:fontcolor=$_tfc:box=1:boxcolor=0x000000B0:boxborderw=$_gbw:x=$_tx:y=$_ty[v]"
done

# 2026-10-18:等代理就绪再启动,避免代理重启时 ffmpeg 卡在输入探测阶段
# (代理的 /api/slots 通了才算就绪,最多等 60s)
for ((_w=0; _w<30; _w++)); do
  if curl -m 3 -s "$PROXY/api/slots" > /dev/null 2>&1; then break; fi
  echo "[grid] 等待代理 $PROXY 就绪... ($((_w+1))/30)" >&2
  sleep 2
done

# ---- 标签覆盖层(2026-10-19) ----
# drawtext reload=1 每帧重载吃 70% CPU,改用:后台一次性 ffmpeg 每 60s 把标签画到透明层,
# 经 FIFO 以 rawvideo(1fps)喂给主 ffmpeg 做 overlay。主 ffmpeg 只做 alpha 混合,几乎不耗 CPU。
if [ "$LABELS_ON" = "1" ]; then
  # 清理上一轮残留(grid.sh 重跑时旧循环还在,用 PID 文件杀)
  for _pf in /tmp/label_writer.pid /tmp/label_feeder.pid; do
    [ -f "$_pf" ] && kill "$(cat "$_pf")" 2>/dev/null
    rm -f "$_pf"
  done
  rm -f /tmp/label_fifo
  mkfifo /tmp/label_fifo
  # 带标签的滤镜:复用布局,把视频 cell 换成透明底(sed 变换,定位逻辑零重复)
  _LVF=$(build_filter "$LAYOUT" "$N")
  OVERLAY_FILTER=$(printf '%s' "$_LVF" | sed -E 's|\[[0-9]+:v\]scale=([0-9]+):([0-9]+):force_original_aspect_ratio=decrease,(setsar=1,)?pad=[0-9]+:[0-9]+:\(ow-iw\)/2:\(oh-ih\)/2|color=c=black@0:s=\1x\2:r=1:d=3600,format=rgba|g')
  # 渲染器:每 60s 更新 label 文件并渲染 60 帧(1fps)到 /tmp/labels.raw(原子替换)
  # 用 ( ) 子 shell 以便继承函数/数组;输出 60 帧后 sleep,下轮自动用新总额
  ( while true; do
      write_label_files
      if ffmpeg -y -v error -nostdin -filter_complex "$OVERLAY_FILTER" -map "[v]" -frames:v 60 -r 1 -f rawvideo -pix_fmt rgba /tmp/labels.raw.tmp 2>/dev/null; then
        mv /tmp/labels.raw.tmp /tmp/labels.raw
      fi
      sleep 60
    done ) &
  echo $! > /tmp/label_writer.pid
  # 等首帧渲染完成(最多 30s),再起 feeder 和主 ffmpeg
  for ((_w=0;_w<30;_w++)); do [ -f /tmp/labels.raw ] && break; sleep 1; done
  # 喂流:循环 cat,整个循环持有一个 FIFO 写端,永不 EOF;文件原子替换后自动用新版
  ( while true; do cat /tmp/labels.raw 2>/dev/null; sleep 0.2; done > /tmp/label_fifo ) &
  echo $! > /tmp/label_feeder.pid
  # 主 ffmpeg:加 rawvideo 输入 + overlay(盖在最上层)
  _ov_idx=$((N + NIMG))
  INPUTS+=( -f rawvideo -pix_fmt rgba -s ${W}x${H} -framerate 1 -i /tmp/label_fifo )
  VFILTER="${VFILTER%\[v\]}[vbase];[vbase][${_ov_idx}:v]overlay=0:0:format=yuv420:eof_action=repeat[v]"
  echo "[grid] 标签覆盖层已启用(输入 ${_ov_idx},60s 刷新)" >&2
fi

exec ffmpeg -y "${INPUTS[@]}" \
  -filter_complex "$VFILTER;$AFILTER" \
  -map "[v]" -map "[a]" -c:v libx264 -preset veryfast -tune zerolatency \
  -b:v $BITRATE -maxrate ${BR_NUM}k -bufsize $((BR_NUM*2))k \
  -pix_fmt yuv420p -r $FPS -g $((FPS*2)) \
  -c:a aac -b:a 128k -ar 44100 -ac 2 \
  -f flv "$RTMP"
