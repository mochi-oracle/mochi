#!/bin/sh
# PDF on stdin -> per-page text on stdout, framed as "@@PAGE <n> <text|ocr> <bytes>\n" + exactly <bytes> bytes.
# Pages whose text layer has fewer than MIN_CHARS non-space characters are treated as scanned and OCR'd.
# Nothing is written outside a private temp dir (run the container with --read-only and a tmpfs /tmp).
set -eu
MAX_BYTES="${MAX_BYTES:-52428800}"   # 50 MiB
MAX_PAGES="${MAX_PAGES:-50}"
MIN_CHARS="${MIN_CHARS:-20}"     # scanned pages have ~0 characters of text layer
DPI="${DPI:-300}"
LANGS="${LANGS:-eng}"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cd "$work"
head -c $((MAX_BYTES + 1)) > in.pdf
[ "$(wc -c < in.pdf)" -le "$MAX_BYTES" ] || { echo "input too large" >&2; exit 4; }
pages=$(pdfinfo in.pdf 2>/dev/null | awk '/^Pages:/ {print $2}')
[ -n "$pages" ] || { echo "not a PDF" >&2; exit 2; }
[ "$pages" -le "$MAX_PAGES" ] || { echo "too many pages: $pages" >&2; exit 3; }
i=1
while [ "$i" -le "$pages" ]; do
  pdftotext -layout -f "$i" -l "$i" in.pdf page.txt
  method=text
  if [ "$(tr -d '[:space:]' < page.txt | wc -c)" -lt "$MIN_CHARS" ]; then
    pdftoppm -r "$DPI" -f "$i" -l "$i" -gray -png in.pdf img
    tesseract img-*.png page -l "$LANGS" --psm 3 >/dev/null 2>&1
    rm -f img-*.png
    method=ocr
  fi
  printf '@@PAGE %s %s %s\n' "$i" "$method" "$(wc -c < page.txt | tr -d ' ')"
  cat page.txt
  i=$((i + 1))
done
