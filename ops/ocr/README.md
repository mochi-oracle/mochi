# Mochi OCR runtime

The `mochi-ocr:1` image contains the intake OCR wrapper, Tesseract 5.3 with English language data, and Poppler's PDF
tools (`pdfinfo`, `pdftotext`, and `pdftoppm`). Poppler extracts text-layer pages; Tesseract recognizes pages whose text
layer is too short. The wrapper emits UTF-8 page text in byte-counted frames and keeps its temporary files under `/tmp`.

The image starts from the official Debian bookworm-slim image pinned by digest. It installs tools from Debian's signed
package repositories, then runs as non-root UID 10001. At runtime, intake starts it with networking disabled, a
read-only root filesystem, a private `/tmp` tmpfs, all Linux capabilities dropped, `no-new-privileges`, a 128-process
limit, and a 1 GiB memory limit. The OCR process does not need network access.

Build it from the repository root:

```sh
docker build -t mochi-ocr:1 ops/ocr
```

Enable it for intake with `PDF_OCR=docker`; `PDF_OCR_IMAGE` can select a different image tag. Intake invokes Docker
with an argv array, pipes PDF bytes to stdin, and reads framed text from stdout. `PDF_OCR_COMMAND` accepts a JSON array
of strings to replace the command when a custom runtime is needed. The default `PDF_OCR=off` keeps PDF uploads rejected.

The intake enclave image installs the same Debian packages and `mochi-ocr.sh` as `/usr/local/bin/mochi-ocr`, then
uses `PDF_OCR=native`. This avoids invoking Docker from inside the enclave while retaining the same input and output
protocol.
