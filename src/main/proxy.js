const USERNAME_RE = /^[a-z0-9_-]{3,24}$/;

/** @returns {{pathname: string} | {error: string}} */
export function resolveMediaUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { error: 'bad_url' };
  }
  if (url.protocol !== 'bonfire:') return { error: 'bad_scheme' };
  const segs = url.pathname.split('/').filter(Boolean);
  const idOf = (s) => (/^\d{1,12}$/.test(s) ? s : null);

  if (url.host === 'media' && segs.length === 2) {
    const [action, id] = segs;
    if ((action === 'preview' || action === 'download') && idOf(id)) {
      return { pathname: `/api/files/${id}/${action}` };
    }
  }
  if (url.host === 'avatar' && segs.length === 1 && USERNAME_RE.test(segs[0])) {
    return { pathname: `/api/avatars/${segs[0]}` };
  }
  return { error: 'not_allowed' };
}

// Hop-by-hop and framing headers we must not pass through verbatim.
const DROP = new Set(['set-cookie', 'x-frame-options', 'connection', 'keep-alive', 'transfer-encoding', 'content-encoding', 'proxy-authenticate', 'www-authenticate']);

export function filterHeaders(headers) {
  const out = {};
  for (const [k, v] of headers) {
    if (DROP.has(k.toLowerCase())) continue;
    out[k] = k.toLowerCase() === 'content-security-policy' ? rewriteCsp(v) : v;
  }
  return out;
}

// Keeps framing to our own scheme rather than dropping the directive.
function rewriteCsp(value) {
  if (!/frame-ancestors/i.test(value)) return value;
  return value.replace(/frame-ancestors[^;]*/i, "frame-ancestors 'self' file:");
}

export function mediaUrlFor(kind, idOrName) {
  if (kind === 'avatar') return `bonfire://avatar/${encodeURIComponent(String(idOrName))}`;
  return `bonfire://media/${kind}/${idOrName}`;
}

export function installMediaProtocol({ protocol, client, isAuthed }) {
  protocol.handle('bonfire', async (request) => {
    const route = resolveMediaUrl(request.url);
    if (route.error) {
      return new Response(route.error, { status: 404, headers: { 'content-type': 'text/plain' } });
    }
    if (!isAuthed()) {
      return new Response('unauthorized', { status: 401, headers: { 'content-type': 'text/plain' } });
    }
    const range = request.headers.get('range') || undefined;
    try {
      const upstream = await client.stream(route.pathname, { range });
      const headers = filterHeaders(upstream.headers);
      if (range && headers['accept-ranges'] === undefined) headers['accept-ranges'] = 'bytes';
      return new Response(request.method === 'HEAD' ? null : upstream.body, {
        status: upstream.status,
        headers,
      });
    } catch (err) {
      return new Response(String(err?.message || 'proxy error'), { status: 502, headers: { 'content-type': 'text/plain' } });
    }
  });
}
