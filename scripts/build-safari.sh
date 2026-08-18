#!/usr/bin/env bash
# Wrap the web extension in a macOS app bundle so Safari can load it.
# Requires full Xcode (the converter does not ship with Command Line Tools).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT="$ROOT/extension"
BUILD="$ROOT/build"
INSTALL_DIR="${INSTALL_DIR:-$HOME/Applications/SafariTranslate}"
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
  CONFIGURATION_BUILD_DIR="$INSTALL_DIR" \
  CODE_SIGN_IDENTITY="-" CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM="" \
  CODE_SIGNING_REQUIRED=NO CODE_SIGNING_ALLOWED=YES \
  build

APP="$INSTALL_DIR/$APP_NAME.app"
[[ -d "$APP" ]] || APP=""
if [[ -z "$APP" ]]; then
  echo "error: build produced no .app" >&2
  exit 1
fi

# Xcode signs ad-hoc via CODE_SIGN_IDENTITY="-" above. Only sign by hand if the
# bundle resources were not sealed, since re-signing after the build's
# RegisterWithLaunchServices step can invalidate the registration.
if [[ ! -d "$APP/Contents/_CodeSignature" ]]; then
  echo "==> Ad-hoc signing bundle"
  codesign --force --sign - --timestamp=none "$APP/Contents/PlugIns/$APP_NAME Extension.appex"
  codesign --force --sign - --timestamp=none "$APP"
fi
codesign --verify --deep --strict "$APP" && echo "==> Signature valid"

echo "==> Registering with Safari"
LSREG=/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister
"$LSREG" -f -R -trusted "$APP"
open -a "$APP"
sleep 5

if pluginkit -m -p com.apple.Safari.web-extension 2>/dev/null | grep -qi "$APP_NAME"; then
  echo "==> Extension registered with Safari"
else
  echo "warning: extension did not register with Safari. Try opening $APP by hand." >&2
fi

cat <<MSG

Built and installed: $APP

Next steps, once only:
  1. Safari > Settings > Advanced > tick "Show features for web developers".
  2. Safari > Settings > Developer > tick "Allow unsigned extensions".
     Ad-hoc signed builds need this, and it resets each time Safari restarts.
     Signing with a real Apple Developer certificate removes that requirement.
  3. Safari > Settings > Extensions > enable $APP_NAME, then grant it access to
     the sites you want translated ("Always Allow on Every Website" is the
     closest match to how Chrome's translator behaves).

MSG
