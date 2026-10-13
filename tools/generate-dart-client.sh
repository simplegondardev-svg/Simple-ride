#!/usr/bin/env bash
# Generate the Dart API client for the Flutter apps from docs/openapi.json.
#
#   tools/generate-dart-client.sh [output-dir]      (default: build/simple_ride_api)
#
# Needs Java 11+ and the Dart SDK (>= 3.8). Uses openapi-generator's dart-dio
# generator with json_serializable, then runs build_runner and dart analyze.
# Regenerate after `pnpm --filter @simple-ride/api openapi` updates the spec.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/build/simple_ride_api}"
GEN_VERSION="7.26.0"
JAR="$ROOT/build/openapi-generator-cli-$GEN_VERSION.jar"

mkdir -p "$ROOT/build"
if [ ! -f "$JAR" ]; then
  curl -fsSL -o "$JAR" \
    "https://repo1.maven.org/maven2/org/openapitools/openapi-generator-cli/$GEN_VERSION/openapi-generator-cli-$GEN_VERSION.jar"
fi

rm -rf "$OUT"
# `format: date` fields (e.g. licenseExpiresOn) stay plain "YYYY-MM-DD" strings: with
# dateLibrary=core they would become DateTime and be sent as full timestamps, which the API rejects.
java -jar "$JAR" generate -i "$ROOT/docs/openapi.json" -g dart-dio -o "$OUT" --type-mappings=date=String \
  --additional-properties=pubName=simple_ride_api,serializationLibrary=json_serializable,dateLibrary=core

# The generator declares Dart >= 3.5, but current json_serializable emits
# null-aware elements (Dart 3.8).
sed -i.bak "s/^  sdk: .*/  sdk: '>=3.8.0 <4.0.0'/" "$OUT/pubspec.yaml" && rm "$OUT/pubspec.yaml.bak"

cd "$OUT"
dart pub get
dart run build_runner build --delete-conflicting-outputs
# Warnings are generator noise (unused imports); errors fail the script.
dart analyze --no-fatal-warnings
echo "Dart client ready in $OUT"
