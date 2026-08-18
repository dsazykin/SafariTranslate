#!/usr/bin/env bash
# Wrap the web extension in a macOS app bundle so Safari can load it.
# Requires full Xcode (the converter does not ship with Command Line Tools).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT="$ROOT/extension"
BUILD="$ROOT/build"
APP_NAME="SafariTranslate"
# Must match the app name's capitalisation: the converter derives the app's own
# identifier from APP_NAME, and Xcode requires the extension's identifier to be a
# case-sensitive prefix match of the parent app's.
BUNDLE_ID="${BUNDLE_ID:-com.$(id -un | tr -cd '[:alnum:]').$APP_NAME}"

if ! xcrun --find safari-web-extension-converter >/dev/null 2>&1; then
  cat >&2 <<'MSG'
error: safari-web-extension-converter not found.

  This tool ships with full Xcode, not the Command Line Tools. Install Xcode
  from the App Store, then point the toolchain at it:

    sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
    sudo xcodebuild -license accept

MSG
  exit 1
fi

echo "==> Converting $EXT"
rm -rf "$BUILD"
mkdir -p "$BUILD"

xcrun safari-web-extension-converter "$EXT" \
  --project-location "$BUILD" \
  --app-name "$APP_NAME" \
  --bundle-identifier "$BUNDLE_ID" \
  --macos-only \
  --swift \
  --no-open \
  --force

PROJ="$BUILD/$APP_NAME/$APP_NAME.xcodeproj"
echo "==> Building $PROJ"
xcodebuild -project "$PROJ" \
  -scheme "$APP_NAME" \
  -configuration Release \
  -derivedDataPath "$BUILD/DerivedData" \
  CODE_SIGN_IDENTITY="-" CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM="" \
  CODE_SIGNING_REQUIRED=NO CODE_SIGNING_ALLOWED=YES \
  build

APP="$(find "$BUILD/DerivedData/Build/Products/Release" -maxdepth 1 -name '*.app' | head -1)"
if [[ -z "$APP" ]]; then
  echo "error: build produced no .app" >&2
  exit 1
fi

echo "==> Ad-hoc signing bundle"
codesign --force --sign - --timestamp=none \
  "$APP/Contents/PlugIns/$APP_NAME Extension.appex"
codesign --force --sign - --timestamp=none "$APP"
codesign --verify --deep --strict --verbose=2 "$APP" 2>&1 | sed 's/^/    /'

echo "==> Installing to /Applications"
rm -rf "/Applications/$APP_NAME.app"
cp -R "$APP" "/Applications/$APP_NAME.app"

cat <<MSG

Built and installed /Applications/$APP_NAME.app

Next steps, once only:
  1. Open /Applications/$APP_NAME.app (it is a container app; it just registers
     the extension with Safari, so you can quit it right after).
  2. Safari > Settings > Advanced > tick "Show features for web developers".
  3. Safari > Settings > Developer > tick "Allow unsigned extensions".
     Ad-hoc signed builds need this, and it resets each time Safari restarts.
     Signing with a real Apple Developer certificate removes that requirement.
  4. Safari > Settings > Extensions > enable $APP_NAME, then grant it access to
     the sites you want translated ("Always Allow on Every Website" is the
     closest match to how Chrome's translator behaves).

MSG
