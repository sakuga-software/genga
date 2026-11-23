import { badRequest, GengaError } from './errors';

export const AUTH_FORM_BYTES = 16 * 1024;
export const JSON_BYTES = 2_000_000;
/** Room for the multipart boundaries and the other fields of an upload form. */
export const UPLOAD_OVERHEAD_BYTES = 64 * 1024;

function tooLarge(): GengaError {
  return new GengaError(413, 'too_large', 'Requête trop volumineuse.');
}

/** Reads the body, but stops at `maxBytes`. The `Content-Length` check comes first. */
export async function readBody(request: Request, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function readForm(request: Request, maxBytes: number): Promise<FormData> {
  const body = await readBody(request, maxBytes);
  const type = request.headers.get('content-type') ?? '';
  try {
    return await new Response(body, { headers: { 'content-type': type } }).formData();
  } catch {
    throw badRequest('Formulaire invalide.');
  }
}

export async function readJson(request: Request, maxBytes = JSON_BYTES): Promise<Record<string, unknown>> {
  const type = request.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) throw badRequest('Corps JSON attendu.');
  const body = await readBody(request, maxBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw badRequest('Corps JSON invalide.');
  }
  return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
}
