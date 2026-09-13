#!/usr/bin/env bash
# After the first Vercel deploy, point the hosted manifests at the real URL:
#   bash set-hosted-url.sh https://kpi-card-demo.vercel.app
set -e
URL="${1%/}"
[ -z "$URL" ] && { echo "usage: bash set-hosted-url.sh https://your-project.vercel.app"; exit 1; }
cd "$(dirname "$0")/trex/hosted"
for f in *.hosted.trex; do
  sed -i '' -E "s|<url>https?://[^/]+/|<url>$URL/|" "$f"
  echo "  $f  →  $(grep -o '<url>[^<]*</url>' "$f")"
done
echo "Done. Re-add the .trex in Tableau (manifest changes need a full remove-and-re-add)."
