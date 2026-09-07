#!/usr/bin/env bash
set -euo pipefail

INPUT="${1:?input mp4 required}"
BGM="${2:?bgm file required}"
OUTPUT="${3:?output mp4 required}"
TARGET_MB="${4:-190}"
AUDIO_KBPS="${5:-128}"

DURATION=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$INPUT")
if [ -z "$DURATION" ]; then
  echo "Could not determine input duration" >&2
  exit 1
fi

# Keep a safety margin for MP4 overhead and bitrate variance.
TARGET_BYTES=$(awk -v mb="$TARGET_MB" 'BEGIN {printf "%.0f", mb * 1000000}')
TOTAL_BPS=$(awk -v bytes="$TARGET_BYTES" -v d="$DURATION" 'BEGIN {printf "%.0f", (bytes * 8 / d) * 0.95}')
AUDIO_BPS=$((AUDIO_KBPS * 1000))
VIDEO_BPS=$((TOTAL_BPS - AUDIO_BPS - 12000))

# Do not let pathological inputs produce an invalid bitrate.
if [ "$VIDEO_BPS" -lt 250000 ]; then
  VIDEO_BPS=250000
fi

FADE_OUT_START=$(awk -v d="$DURATION" 'BEGIN {x=d-1.5; if(x<0)x=0; printf "%.3f", x}')

echo "duration_seconds=$DURATION"
echo "target_mb=$TARGET_MB"
echo "video_bps=$VIDEO_BPS"
echo "audio_bps=$AUDIO_BPS"

rm -f ffmpeg2pass-0.log ffmpeg2pass-0.log.mbtree

ffmpeg -y -i "$INPUT" \
  -c:v libx264 -preset medium -b:v "$VIDEO_BPS" \
  -pix_fmt yuv420p \
  -pass 1 -an -f mp4 /dev/null

ffmpeg -y \
  -i "$INPUT" \
  -stream_loop -1 -i "$BGM" \
  -filter_complex "[1:a]volume=0.02,afade=t=in:st=0:d=1,afade=t=out:st=${FADE_OUT_START}:d=1.5[bgm];[0:a][bgm]amix=inputs=2:duration=first:dropout_transition=0[a]" \
  -map 0:v:0 -map "[a]" \
  -c:v libx264 -preset medium -b:v "$VIDEO_BPS" \
  -pix_fmt yuv420p -pass 2 \
  -c:a aac -b:a "${AUDIO_KBPS}k" \
  -movflags +faststart -shortest \
  "$OUTPUT"

rm -f ffmpeg2pass-0.log ffmpeg2pass-0.log.mbtree

SIZE=$(stat -c%s "$OUTPUT")
echo "final_bytes=$SIZE"

if [ "$SIZE" -ge 200000000 ]; then
  echo "Final output exceeds 200 MB hard limit" >&2
  exit 2
fi
