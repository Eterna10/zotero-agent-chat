#!/usr/bin/env bash
# 打包插件并生成 updates.json
#   ./build.sh            → releases/zotero-agent-chat-<版本>.xpi + 更新 updates.json
# 发布：git add -A && git commit -m "release vX.Y.Z" && git push
# Zotero 通过 manifest.json 里的 update_url 读取 updates.json，发现新版本后自动下载 update_link。
set -euo pipefail
cd "$(dirname "$0")"

REPO="Eterna10/zotero-agent-chat"
BRANCH="main"
ID=$(python3 -c 'import json;print(json.load(open("manifest.json"))["applications"]["zotero"]["id"])')
VERSION=$(python3 -c 'import json;print(json.load(open("manifest.json"))["version"])')
MIN=$(python3 -c 'import json;print(json.load(open("manifest.json"))["applications"]["zotero"]["strict_min_version"])')
MAX=$(python3 -c 'import json;print(json.load(open("manifest.json"))["applications"]["zotero"]["strict_max_version"])')

mkdir -p releases
XPI="releases/zotero-agent-chat-${VERSION}.xpi"
rm -f "$XPI"
zip -qr -X "$XPI" manifest.json bootstrap.js prefs.js content icons locale
HASH=$(sha256sum "$XPI" | cut -d' ' -f1)

python3 - "$ID" "$VERSION" "$MIN" "$MAX" "$REPO" "$BRANCH" "$XPI" "$HASH" <<'PY'
import json, sys
pid, ver, mn, mx, repo, branch, xpi, h = sys.argv[1:]
data = {"addons": {pid: {"updates": [{
    "version": ver,
    "update_link": f"https://raw.githubusercontent.com/{repo}/{branch}/{xpi}",
    "update_hash": f"sha256:{h}",
    "applications": {"zotero": {"strict_min_version": mn, "strict_max_version": mx}},
}]}}}
with open("updates.json", "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
    f.write("\n")
PY

echo "built $XPI ($HASH)"
