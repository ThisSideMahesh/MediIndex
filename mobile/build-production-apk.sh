#!/bin/bash
#
# MediIndex Mobile - Production APK Build Script
#
# This script builds a standalone Android release APK configured for the
# production Vercel backend (https://mediindex.vercel.app).
#
# WHY THIS SCRIPT LOOKS THE WAY IT DOES (read before editing):
#
# Gradle's `assembleRelease` runs BundleHermesCTask, which shells out to:
#   node <cliFile> export:embed --platform android --dev false ...
# via Gradle's ExecOperations, which by default inherits the *Gradle daemon
# process's* environment — NOT necessarily the shell environment at the
# moment `./gradlew` is invoked. Gradle daemons are long-lived and cache
# their environment at daemon startup, so `export FOO=bar && ./gradlew ...`
# can silently run against a stale environment if a daemon from an earlier
# invocation is still alive.
#
# Separately, Expo's `export:embed` sets NODE_ENV=production for release
# builds and then loads `.env.production` (higher priority) merged with
# `.env` (lower priority) via `@expo/env`. Critically, `@expo/env` NEVER
# overwrites a key that is already present in `process.env` — so if a stale
# value of EXPO_PUBLIC_MOBILE_API_BASE_URL is already set in that process
# (inherited from a stale daemon), `.env.production` is silently ignored.
#
# This is exactly how the previous release APK ended up embedding
# http://172.20.10.5:3000 instead of https://mediindex.vercel.app despite
# .env.production existing and despite this script exporting the correct
# value in its own shell.
#
# THE FIX applied here:
#   1. Hard-fail before building if the production URL is not the
#      effective value in THIS shell (pre-build guard).
#   2. Stop any running Gradle daemon (`./gradlew --stop`) so no stale
#      cached environment can be reused.
#   3. Run the build with `--no-daemon`, which removes daemon environment
#      caching entirely for this invocation — the Gradle process and every
#      subprocess it spawns (including the Node/Expo bundler) inherit
#      exactly this script's current shell environment, guaranteed.
#   4. Also pass the value as a Gradle project property
#      (-PEXPO_PUBLIC_MOBILE_API_BASE_URL=...) as a defense-in-depth signal
#      (visible in `./gradlew --info` logs), though the exported shell env
#      var is what actually reaches the Node subprocess.
#   5. After building, statically verify the ACTUAL embedded JS bundle
#      inside the produced APK. Gradle reporting "BUILD SUCCESSFUL" is not
#      accepted as proof of correct configuration — this script fails the
#      build if the production URL is absent or the local dev URL is
#      present in the bundle.
#
# PREREQUISITES:
# - Java Runtime Environment (JRE) or Java Development Kit (JDK) 17+ installed
# - Android SDK configured (via Expo/React Native setup)
# - All npm dependencies installed (run `npm install` if needed)
#
# USAGE:
#   chmod +x build-production-apk.sh
#   ./build-production-apk.sh
#

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

PRODUCTION_URL="https://mediindex.vercel.app"
LOCAL_DEV_URL="http://172.20.10.5:3000"

echo ""
echo "═══════════════════════════════════════════════════════════════════════════"
echo "  MediIndex Mobile - Production APK Build"
echo "  Target: ${PRODUCTION_URL}"
echo "═══════════════════════════════════════════════════════════════════════════"
echo ""

# Check Java installation
echo -e "${BLUE}[1/9]${NC} Checking Java installation..."
if ! command -v java &> /dev/null; then
    echo -e "${RED}ERROR: Java is not installed.${NC}"
    echo ""
    echo "Please install Java 17+ using one of these methods:"
    echo "  • Homebrew: brew install openjdk@17"
    echo "  • SDKMAN: sdk install java 17.0.9-tem"
    echo "  • Download: https://adoptium.net/"
    echo ""
    exit 1
fi

JAVA_VERSION=$(java -version 2>&1 | head -n 1 | awk -F '"' '{print $2}')
echo -e "${GREEN}✓${NC} Java installed: $JAVA_VERSION"
echo ""

# Check we're in the mobile directory
if [ ! -f "package.json" ] || [ ! -d "android" ]; then
    echo -e "${RED}ERROR: Must run from mobile/ directory${NC}"
    echo "Expected: /Users/thisside_mahesh/Projects/MediIndex - code/MediIndex/mobile"
    exit 1
fi

# Set production environment variable in THIS shell.
echo -e "${BLUE}[2/9]${NC} Setting production environment..."
export EXPO_PUBLIC_MOBILE_API_BASE_URL="${PRODUCTION_URL}"
echo -e "${GREEN}✓${NC} API base URL: $EXPO_PUBLIC_MOBILE_API_BASE_URL"
echo ""

# ─── PRE-BUILD GUARD (Task 5) ────────────────────────────────────────────────
# Verify the effective value in THIS shell before doing anything expensive.
# This does not guarantee what the Gradle daemon/subprocess will see (that is
# handled by --no-daemon below), but it catches typos/misconfiguration early
# and documents the required value explicitly.
echo -e "${BLUE}[3/9]${NC} Pre-build guard: verifying effective environment..."
if [ "${EXPO_PUBLIC_MOBILE_API_BASE_URL}" != "${PRODUCTION_URL}" ]; then
    echo -e "${RED}ABORT: EXPO_PUBLIC_MOBILE_API_BASE_URL is not the production URL.${NC}"
    echo "  Expected: ${PRODUCTION_URL}"
    echo "  Actual:   ${EXPO_PUBLIC_MOBILE_API_BASE_URL}"
    exit 1
fi
echo -e "${GREEN}✓${NC} Effective EXPO_PUBLIC_MOBILE_API_BASE_URL = ${PRODUCTION_URL}"
echo ""

# Verify .env.production exists (documentation / fallback only — the shell
# env var exported above is what actually governs the build, per @expo/env's
# "never overwrite an already-set key" rule).
if [ ! -f ".env.production" ]; then
    echo -e "${YELLOW}⚠${NC}  .env.production not found, creating it..."
    cat > .env.production << EOF
# MediIndex mobile — PRODUCTION configuration
EXPO_PUBLIC_MOBILE_API_BASE_URL=${PRODUCTION_URL}
EOF
    echo -e "${GREEN}✓${NC} Created .env.production"
else
    echo -e "${GREEN}✓${NC} .env.production exists"
fi
echo ""

# Run TypeScript validation
echo -e "${BLUE}[4/9]${NC} Running TypeScript validation..."
if npm run typecheck; then
    echo -e "${GREEN}✓${NC} TypeScript validation passed"
else
    echo -e "${RED}ERROR: TypeScript validation failed${NC}"
    exit 1
fi
echo ""

# Run tests
echo -e "${BLUE}[5/9]${NC} Running test suite..."
if npm test; then
    echo -e "${GREEN}✓${NC} All tests passed"
else
    echo -e "${RED}ERROR: Test suite failed${NC}"
    exit 1
fi
echo ""

# ─── STOP ANY RUNNING GRADLE DAEMON ──────────────────────────────────────────
# A live daemon from a previous invocation may have cached an earlier (e.g.
# development) environment. Stopping it guarantees a clean slate.
echo -e "${BLUE}[6/9]${NC} Stopping any running Gradle daemon..."
cd android
./gradlew --stop > /dev/null 2>&1 || true
echo -e "${GREEN}✓${NC} Gradle daemon stopped (or none was running)"
echo ""

# Clean previous builds
echo -e "${BLUE}[7/9]${NC} Cleaning previous builds..."
./gradlew clean --no-daemon
echo -e "${GREEN}✓${NC} Build cleaned"
echo ""

# ─── BUILD RELEASE APK ────────────────────────────────────────────────────────
# --no-daemon: this Gradle invocation (and every subprocess it spawns,
# including the Node/Expo `export:embed` bundler) runs in a fresh process
# that inherits exactly THIS script's current shell environment. No daemon
# environment caching can interfere.
#
# -PEXPO_PUBLIC_MOBILE_API_BASE_URL: defense-in-depth, visible in Gradle logs.
echo -e "${BLUE}[8/9]${NC} Building release APK (--no-daemon, fresh environment)..."
echo "This may take 3-5 minutes..."
echo ""

if ./gradlew assembleRelease --no-daemon -PEXPO_PUBLIC_MOBILE_API_BASE_URL="${PRODUCTION_URL}"; then
    echo ""
    echo -e "${GREEN}✓${NC} Gradle reported BUILD SUCCESSFUL"
    echo -e "${YELLOW}  (This alone does NOT prove correct configuration — verifying bundle contents next)${NC}"
else
    echo ""
    echo -e "${RED}ERROR: APK build failed${NC}"
    echo "Check the Gradle output above for errors"
    exit 1
fi
echo ""

# ─── VERIFY APK EXISTS ────────────────────────────────────────────────────────
APK_PATH="app/build/outputs/apk/release/app-release.apk"

if [ ! -f "$APK_PATH" ]; then
    echo -e "${RED}ERROR: APK not found at expected location${NC}"
    echo "Expected: android/$APK_PATH"
    exit 1
fi

APK_SIZE=$(ls -lh "$APK_PATH" | awk '{print $5}')
APK_FULL_PATH="$(pwd)/$APK_PATH"

# ─── POST-BUILD GUARD: STATIC BUNDLE VERIFICATION (Task 7 support) ──────────
# This is a HARD gate. "BUILD SUCCESSFUL" from Gradle is not sufficient
# evidence — the actual embedded JS bundle must contain the production URL
# and must NOT contain the local development URL.
echo -e "${BLUE}[9/9]${NC} Verifying embedded API URL in the built APK (hard gate)..."
TEMP_BUNDLE=$(mktemp)
unzip -p "$APK_PATH" assets/index.android.bundle > "$TEMP_BUNDLE" 2>/dev/null || true

PROD_URL_FOUND=false
LOCAL_URL_FOUND=false

if grep -aq "${PRODUCTION_URL}" "$TEMP_BUNDLE"; then
    PROD_URL_FOUND=true
    echo -e "${GREEN}✓${NC} Production URL found in bundle: ${PRODUCTION_URL}"
else
    echo -e "${RED}✗${NC} Production URL NOT found in bundle"
fi

if grep -aq "${LOCAL_DEV_URL}" "$TEMP_BUNDLE"; then
    LOCAL_URL_FOUND=true
    echo -e "${RED}✗${NC} Local development URL FOUND in bundle: ${LOCAL_DEV_URL} (must be absent)"
else
    echo -e "${GREEN}✓${NC} Local development URL absent from bundle"
fi

rm -f "$TEMP_BUNDLE"
echo ""

if [ "$PROD_URL_FOUND" != "true" ] || [ "$LOCAL_URL_FOUND" = "true" ]; then
    echo "═══════════════════════════════════════════════════════════════════════════"
    echo -e "${RED}BUILD REJECTED — APK produced but configuration is WRONG${NC}"
    echo "═══════════════════════════════════════════════════════════════════════════"
    echo ""
    echo "  APK Location: $APK_FULL_PATH"
    echo "  This APK is NOT safe to use for production testing."
    echo "  Do not install it. Investigate the environment/daemon state and rebuild."
    echo ""
    exit 1
fi

# Final report
echo "═══════════════════════════════════════════════════════════════════════════"
echo -e "${GREEN}BUILD COMPLETE AND VERIFIED${NC}"
echo "═══════════════════════════════════════════════════════════════════════════"
echo ""
echo "  APK Location:  $APK_FULL_PATH"
echo "  APK Size:      $APK_SIZE"
echo "  API Base URL:  ${PRODUCTION_URL}  (verified present in bundle)"
echo "  Local dev URL: absent from bundle (verified)"
echo "  Package:       com.mediindex.stockentry"
echo "  Version:       1.0.0"
echo ""
echo "═══════════════════════════════════════════════════════════════════════════"
echo ""
echo -e "${YELLOW}NEXT STEPS:${NC}"
echo "  1. Do NOT install automatically — install manually when ready:"
echo "     adb install $APK_PATH"
echo ""
echo "  2. Launch app and verify:"
echo "     • App opens to pairing screen"
echo "     • Settings shows API URL: ${PRODUCTION_URL}"
echo ""
echo "  3. DO NOT pair device or submit stock entries yet"
echo "     (awaiting explicit authorization)"
echo ""
echo -e "${GREEN}Build script completed successfully.${NC}"
echo ""
