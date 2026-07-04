#!/bin/sh
set -eu

missing=""

check() {
  name="$1"
  shift
  if ! "$@" >/tmp/docucorex-"$name".version 2>/tmp/docucorex-"$name".error; then
    missing="$missing $name"
    echo "Missing or broken OCR dependency: $name" >&2
    cat /tmp/docucorex-"$name".error >&2 || true
  else
    version="$(head -n 1 /tmp/docucorex-"$name".version || true)"
    echo "$name: $version"
  fi
}

check ocrmypdf ocrmypdf --version
check tesseract tesseract --version
check ghostscript gs --version
check qpdf qpdf --version

if [ -n "$missing" ]; then
  echo "DocuCoreX conversion worker cannot start. Missing dependencies:$missing" >&2
  exit 1
fi

echo "DocuCoreX conversion worker OCR runtime is ready."
