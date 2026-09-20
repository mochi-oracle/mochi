# Mochi OCR runtime for the intake service (local dev and the intake enclave image).
# Base: Docker Official Image, pinned by digest. Tools: Debian's signed apt packages only.
FROM debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251
RUN apt-get update \
 && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-eng poppler-utils \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin ocr
COPY mochi-ocr.sh /usr/local/bin/mochi-ocr
RUN chmod 0755 /usr/local/bin/mochi-ocr
USER 10001:10001
ENTRYPOINT ["/usr/local/bin/mochi-ocr"]
