#!/usr/bin/env bash
# Joins the clips from record-walkthrough.js into one mp4: store page, PayPal popup, then the rest.
# Usage: scripts/stitch-walkthrough.sh [dir]   (default data/walkthrough; needs ffmpeg)
set -euo pipefail
dir="${1:-data/walkthrough}"
read -r MAIN POP A B C < <(node -e "
const t=require(require('path').resolve('$dir/timeline.json'));const o=t.marks[0].t,c=t.marks[1].t;
console.log(t.main.file,t.popup.file,(o-t.main.start).toFixed(2),(c-t.popup.start).toFixed(2),(c-t.main.start).toFixed(2))")
ffmpeg -y -v error -i "$MAIN" -i "$POP" -filter_complex "\
[0:v]trim=0:$A,setpts=PTS-STARTPTS,fps=25,scale=1280:800,setsar=1[a];\
[1:v]trim=0:$B,setpts=PTS-STARTPTS,fps=25,scale=1280:800:force_original_aspect_ratio=decrease,pad=1280:800:(ow-iw)/2:(oh-ih)/2:color=0x222222,setsar=1[b];\
[0:v]trim=start=$C,setpts=PTS-STARTPTS,fps=25,scale=1280:800,setsar=1[c];\
[a][b][c]concat=n=3:v=1:a=0,format=yuv420p[v]" -map "[v]" -c:v libx264 -crf 22 -preset medium -movflags +faststart "$dir/walkthrough.mp4"
echo "$dir/walkthrough.mp4"
