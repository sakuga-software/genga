import { createReadableStreamFromReadable, writeReadableStreamToWritable } from '@react-router/node';

/**
 * Sends the requests of the MCP path to `genga.handle` before React Router. React Router refuses
 * a cross-origin POST to a page route with 400, before its middleware runs. The MCP path is a
 * setting, so it has no route of its own, and the origin check of MCP must decide.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{ genga: import('genga/server').Genga; settings: { mcp: { enabled: boolean; path: string } } } | undefined} server
 * @returns {Promise<boolean>} False when the request is not for MCP.
 */
export async function serveMcp(req, res, server) {
  if (!server?.settings.mcp.enabled) return false;
  let url;
  try {
    url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  } catch {
    return false;
  }
  if (url.pathname.replace(/\/+$/, '').toLowerCase() !== server.settings.mcp.path.toLowerCase()) return false;
  const headers = new Headers();
  try {
    for (let index = 0; index < req.rawHeaders.length; index += 2) {
      headers.append(req.rawHeaders[index], req.rawHeaders[index + 1]);
    }
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Request: a header is not valid.');
    return true;
  }
  const controller = new AbortController();
  res.on('close', () => controller.abort());
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const request = new Request(url, {
    method: req.method,
    headers,
    body: hasBody ? createReadableStreamFromReadable(req) : undefined,
    duplex: hasBody ? 'half' : undefined,
    signal: controller.signal,
  });
  const response = await server.genga.handle(request);
  if (!response) return false;
  res.statusCode = response.status;
  for (const [name, value] of response.headers) {
    if (name !== 'set-cookie') res.appendHeader(name, value);
  }
  for (const cookie of response.headers.getSetCookie()) res.appendHeader('set-cookie', cookie);
  if (response.body && req.method !== 'HEAD') await writeReadableStreamToWritable(response.body, res);
  else res.end();
  return true;
}
