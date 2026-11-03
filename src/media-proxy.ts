const encoder = new TextEncoder();
const TTL_SECONDS = 3600;

function base64url(bytes: Uint8Array): string {
   return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decode(value: string): Uint8Array {
   return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
}
function validMediaURL(value: string): boolean {
   try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password && !url.port
         && url.hostname.endsWith('.googlevideo.com');
   } catch { return false; }
}
async function key(secret: string): Promise<CryptoKey> {
   return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
export async function authorized(request: Request, secret: string): Promise<boolean> {
   if (!secret) return false;
   const [supplied, expected] = await Promise.all([
      crypto.subtle.digest('SHA-256', encoder.encode(request.headers.get('Authorization') ?? '')),
      crypto.subtle.digest('SHA-256', encoder.encode(`Bearer ${secret}`)),
   ]);
   return crypto.subtle.timingSafeEqual(supplied, expected);
}
export async function mediaURL(origin: string, source: string, secret: string, now = Date.now()): Promise<string> {
   if (!validMediaURL(source)) throw new Error('Unsupported media origin');
   const payload = encoder.encode(JSON.stringify({ url: source, expires: Math.floor(now / 1000) + TTL_SECONDS }));
   const signature = await crypto.subtle.sign('HMAC', await key(secret), payload);
   const url = new URL('/media', origin);
   url.searchParams.set('ticket', `${base64url(payload)}.${base64url(new Uint8Array(signature))}`);
   return url.toString();
}
export async function verifyMediaTicket(ticket: string, secret: string, now = Date.now()): Promise<string | undefined> {
   try {
      const parts = ticket.split('.');
      if (parts.length !== 2 || ticket.length > 15000 || !secret) return;
      const payload = decode(parts[0]);
      if (!await crypto.subtle.verify('HMAC', await key(secret), decode(parts[1]), payload)) return;
      const data = JSON.parse(new TextDecoder().decode(payload));
      if (typeof data.url !== 'string' || !Number.isFinite(data.expires)
         || data.expires <= Math.floor(now / 1000) || !validMediaURL(data.url)) return;
      return data.url;
   } catch { return; }
}
export async function relayMedia(request: Request, secret: string): Promise<Response> {
   const source = await verifyMediaTicket(new URL(request.url).searchParams.get('ticket') ?? '', secret);
   if (!source) return new Response('Invalid or expired download', { status: 403 });
   if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
   const headers = new Headers();
   for (const name of ['Range', 'If-Range']) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
   }
   let url = source;
   for (let redirects = 0; redirects <= 3; redirects++) {
      const response = await fetch(url, { method: request.method, headers, redirect: 'manual', signal: request.signal });
      if (response.status >= 300 && response.status < 400 && response.headers.has('Location')) {
         const target = new URL(response.headers.get('Location')!, url).toString();
         await response.body?.cancel();
         if (!validMediaURL(target)) return new Response('Invalid media redirect', { status: 502 });
         url = target;
         continue;
      }
      const resultHeaders = new Headers({ 'Cache-Control': 'private, no-store' });
      for (const name of ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges', 'ETag', 'Last-Modified']) {
         const value = response.headers.get(name);
         if (value) resultHeaders.set(name, value);
      }
      return new Response(response.body, { status: response.status, headers: resultHeaders });
   }
   return new Response('Too many media redirects', { status: 502 });
}
const allowedHosts = new Set(['www.youtube.com', 'youtube.com', 'm.youtube.com', 'www.youtube-nocookie.com', 'youtubei.googleapis.com', 'i.ytimg.com', 's.ytimg.com']);
export function serverFetch(signal: AbortSignal): typeof fetch {
   return async (input, init) => {
      let request = new Request(input, init);
      for (let redirects = 0; redirects <= 3; redirects++) {
         const url = new URL(request.url);
         if (url.protocol !== 'https:' || url.port || url.username || url.password || !allowedHosts.has(url.hostname)) {
            throw new Error('Unsupported extraction origin');
         }
         const response = await fetch(request, { redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) });
         if (response.status < 300 || response.status >= 400 || !response.headers.has('Location')) return response;
         const target = new URL(response.headers.get('Location')!, request.url);
         await response.body?.cancel();
         if (request.method !== 'GET' && request.method !== 'HEAD') throw new Error('Unexpected extraction redirect');
         request = new Request(target, { headers: request.headers });
      }
      throw new Error('Too many extraction redirects');
   };
}
