/**
 * Reads a request body with a size cap and a deadline for the whole body, so a caller that sends slowly (one byte a
 * second) holds the request handler and its buffered bytes for at most the deadline, and never reaches whatever the
 * caller admits it to next.
 *
 * The connection is another matter: after an early response (408, 413, or 503 while the body is still arriving) Bun
 * keeps the socket open until the server's idleTimeout, even while the caller keeps sending. Responses to an abandoned
 * body therefore carry `Connection: close` (abandonedBodyResponse), and the server's fetch wrapper passes them through
 * closeAbandonedConnection, which shortens that socket's idle timeout to the minimum (Bun closes it within about four
 * seconds) instead of the server-wide one.
 */
export const BODY_READ_DEADLINE_MS = 12_000;

export class BodyReadError extends Error {
  constructor(readonly status: 408 | 413 | 503, message: string) { super(message); this.name = 'BodyReadError'; }
}

export type BodyReadOptions = {
  maxBytes: number;
  deadlineMs?: number;
  /** Called before each chunk is kept; throw (usually a 503 BodyReadError) to stop reading. */
  onChunk?: (bytes: number) => void;
};

export async function readBoundedBody(request: Request, options: BodyReadOptions): Promise<Uint8Array> {
  if (Number(request.headers.get('content-length') ?? 0) > options.maxBytes) throw new BodyReadError(413, 'Request too large');
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BodyReadError(408, 'Request body was not received in time')), options.deadlineMs ?? BODY_READ_DEADLINE_MS);
  });
  expired.catch(() => {});
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), expired]);
      if (done) break;
      length += value.byteLength;
      if (length > options.maxBytes) throw new BodyReadError(413, 'Request too large');
      options.onChunk?.(value.byteLength);
      chunks.push(value);
    }
  } catch (error) {
    reader.cancel().catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

/** Marks a response to a request whose body was not read to the end, so its connection is not kept for reuse. */
export function abandonedBodyResponse(response: Response): Response {
  response.headers.set('connection', 'close');
  return response;
}

/**
 * For Bun.serve's fetch wrapper: when the response is marked by abandonedBodyResponse, give that request's socket the
 * shortest idle timeout, so a caller still sending the abandoned body loses its connection within seconds rather than
 * holding it for the server-wide idleTimeout.
 */
export function closeAbandonedConnection(server: { timeout(request: Request, seconds: number): void }, request: Request, response: Response): Response {
  if (response.headers.get('connection') === 'close') server.timeout(request, 1);
  return response;
}
