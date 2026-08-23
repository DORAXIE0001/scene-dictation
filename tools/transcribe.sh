#!/bin/bash
# 用本地 Whisper 把视频转写成 .srt 字幕（英文），供听写网站「导入字幕」使用。
# 用法：tools/transcribe.sh 1/S01E01.mp4
# 输出：与视频同目录同名的 .srt（如 1/S01E01.srt），全程离线，不上传任何内容。
set -euo pipefail

VIDEO="$1"
MODEL="$(dirname "$0")/../models/ggml-small.en.bin"
BASE="${VIDEO%.*}"
TMP_WAV="$(mktemp -t transcribe).wav"

if [ ! -f "$MODEL" ]; then
  echo "缺少模型文件 $MODEL（从 https://huggingface.co/ggerganov/whisper.cpp 下载 ggml-small.en.bin）" >&2
  exit 1
fi

# Whisper 只吃 16kHz 单声道 wav，先抽音轨
ffmpeg -v error -y -i "$VIDEO" -vn -ar 16000 -ac 1 "$TMP_WAV"

# --output-srt 直接产出 srt；-of 指定输出前缀（whisper 会自己加 .srt 后缀）
whisper-cli -m "$MODEL" -f "$TMP_WAV" --output-srt -of "$BASE" --language en

rm -f "$TMP_WAV"
echo "完成：${BASE}.srt"
