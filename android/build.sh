#!/usr/bin/env bash
# 手工构建 Cockpit APK（aapt2 + javac + d8 + apksigner，不用 Gradle）
#   bash android/build.sh            # 构建
#   bash android/build.sh install    # 构建并装到已连设备
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/build"
# SDK 可能装在 Homebrew 的 android-commandlinetools 下，也可能在 ~/Library/Android/sdk
find_sdk() {
  for d in "${ANDROID_HOME:-}" "$HOME/Library/Android/sdk" \
           /opt/homebrew/share/android-commandlinetools /usr/local/share/android-commandlinetools; do
    [ -n "$d" ] && [ -d "$d/build-tools" ] && [ -d "$d/platforms" ] && { echo "$d"; return; }
  done
  echo "找不到含 build-tools 与 platforms 的 Android SDK" >&2; exit 1
}
SDK="$(find_sdk)"
BT="$(ls -d "$SDK"/build-tools/* | sort -V | tail -1)"
PLATFORM="$(ls -d "$SDK"/platforms/* | sort -V | tail -1)/android.jar"
JAVA_HOME_DIR="${JAVA_HOME:-/opt/homebrew/opt/openjdk@17}"
export PATH="$JAVA_HOME_DIR/bin:$BT:$PATH"

echo "SDK      : $SDK"
echo "build-tools: $(basename "$BT")"
echo "platform : $(basename "$(dirname "$PLATFORM")")"
echo "java     : $(java -version 2>&1 | head -1)"

# 令牌与地址从本机配置注入，不写死在仓库里
TOKEN="$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.claude-cockpit/auth.json')))['token'])" 2>/dev/null || echo '')"
BASE="${COCKPIT_PUBLIC_URL:-}"
[ -n "$BASE" ] || BASE="$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.claude-cockpit/config.json'))).get('publicUrl',''))" 2>/dev/null || echo '')"
if [ -z "$BASE" ]; then
  echo "请在 ~/.claude-cockpit/config.json 里设置 publicUrl，或导出 COCKPIT_PUBLIC_URL" >&2
  exit 1
fi
BASE="${BASE%/}/"
echo "base url : $BASE"
echo "token    : ${TOKEN:0:6}…（构建期注入）"

rm -rf "$OUT"
mkdir -p "$OUT/res/values" "$OUT/gen" "$OUT/classes" "$OUT/compiled"
cp -R "$HERE/res/." "$OUT/res/"
cp -R "$HERE/mipmap-anydpi" "$OUT/res/" 2>/dev/null || true

cat > "$OUT/res/values/build.xml" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="build_token">$TOKEN</string>
</resources>
EOF
python3 - "$OUT/res/values/strings.xml" "$BASE" <<'PY'
import sys, re, pathlib
p, base = pathlib.Path(sys.argv[1]), sys.argv[2]
s = p.read_text()
s = re.sub(r'(<string name="default_url">).*?(</string>)', r'\g<1>' + base + r'\g<2>', s)
p.write_text(s)
PY

echo "→ 编译资源"
find "$OUT/res" -type f \( -name '*.xml' -o -name '*.png' \) -print0 \
  | xargs -0 aapt2 compile -o "$OUT/compiled" >/dev/null

echo "→ 链接资源"
aapt2 link -o "$OUT/app-unsigned.apk" \
  -I "$PLATFORM" \
  --manifest "$HERE/AndroidManifest.xml" \
  --java "$OUT/gen" \
  --min-sdk-version 24 --target-sdk-version 34 \
  --auto-add-overlay \
  $(ls "$OUT/compiled"/*.flat | sed 's/^/-R /')

echo "→ 编译 Java"
javac -source 17 -target 17 -nowarn -encoding UTF-8 \
  -classpath "$PLATFORM" \
  -d "$OUT/classes" \
  $(find "$HERE/java" "$OUT/gen" -name '*.java') 2>&1 | grep -v "^注: \|bootstrap class path\|警告: " || true

echo "→ dex"
d8 --min-api 24 --output "$OUT" $(find "$OUT/classes" -name '*.class') --lib "$PLATFORM"

echo "→ 打包"
(cd "$OUT" && zip -q -u app-unsigned.apk classes.dex)

echo "→ 对齐与签名"
KS="$HERE/debug.keystore"
if [ ! -f "$KS" ]; then
  keytool -genkeypair -keystore "$KS" -alias cockpit -storepass cockpit -keypass cockpit \
    -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Claude Cockpit,O=looperhome,C=CN" >/dev/null 2>&1
  echo "  已生成签名库 $KS"
fi
zipalign -f 4 "$OUT/app-unsigned.apk" "$OUT/cockpit.apk"
apksigner sign --ks "$KS" --ks-pass pass:cockpit --key-pass pass:cockpit "$OUT/cockpit.apk"
apksigner verify "$OUT/cockpit.apk" && echo "签名校验通过"

ls -lh "$OUT/cockpit.apk" | awk '{print "\nAPK: " $9 "  (" $5 ")"}'

if [ "${1:-}" = "install" ]; then
  echo "→ 安装到设备"
  adb install -r "$OUT/cockpit.apk"
fi
