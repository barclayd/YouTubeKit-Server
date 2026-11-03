import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SELF } from 'cloudflare:test';
import { mediaURL, relayMedia, serverFetch, verifyMediaTicket } from '../src/media-proxy';
const source = 'https://rr1.example.googlevideo.com/videoplayback?id=test';
const secret = 'test-signing-key';

beforeEach(() => { vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network request')); });
afterEach(() => { vi.restoreAllMocks(); });

it('requires authentication before starting extraction', async () => {
   const response = await SELF.fetch('https://example.com/v1?videoID=jNQXAC9IVRw', { headers: { Upgrade: 'websocket' } });
   expect(response.status).toBe(401);
});
it('rejects malformed video identifiers before extraction', async () => {
   const response = await SELF.fetch('https://example.com/v1?videoID=bad', { headers: { Upgrade: 'websocket', Authorization: 'Bearer test-token' } });
   expect(response.status).toBe(400);
});
it('allows a signed source only until expiry and rejects changed tickets', async () => {
   const url = new URL(await mediaURL('https://example.com', source, secret, 1000));
   const ticket = url.searchParams.get('ticket')!;
   expect(await verifyMediaTicket(ticket, secret, 2000)).toBe(source);
   expect(await verifyMediaTicket(ticket, secret, 3601000)).toBeUndefined();
   expect(await verifyMediaTicket(ticket + 'changed', secret, 2000)).toBeUndefined();
   expect(await verifyMediaTicket(ticket, 'wrong-secret', 2000)).toBeUndefined();
});
it('cannot issue tickets for arbitrary servers or credentials', async () => {
   for (const url of ['http://rr1.example.googlevideo.com/a', 'https://googlevideo.com.evil.test/a', 'https://localhost/a', 'https://user@rr1.example.googlevideo.com/a']) {
      await expect(mediaURL('https://example.com', url, secret)).rejects.toThrow();
   }
});
it('streams partial responses and preserves byte range headers', async () => {
   vi.mocked(fetch).mockResolvedValueOnce(new Response('test', { status: 206, headers: { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 1-4/9', 'Accept-Ranges': 'bytes' } }));
   const url = await mediaURL('https://example.com', source, secret);
   const response = await relayMedia(new Request(url, { headers: { Range: 'bytes=1-4' } }), secret);
   expect(response.status).toBe(206);
   expect(response.headers.get('Content-Range')).toBe('bytes 1-4/9');
   expect(await response.text()).toBe('test');
   expect(vi.mocked(fetch).mock.calls[0][0]).toBe(source);
   expect(new Headers(vi.mocked(fetch).mock.calls[0][1]?.headers).get('Range')).toBe('bytes=1-4');
});
it('rejects unsigned media requests without fetching upstream', async () => {
   expect((await relayMedia(new Request('https://example.com/media?ticket=invalid'), secret)).status).toBe(403);
});
it('blocks redirects from media to unrelated origins', async () => {
   vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 302, headers: { Location: 'https://evil.test/private' } }));
   const url = await mediaURL('https://example.com', source, secret);
   expect((await relayMedia(new Request(url), secret)).status).toBe(502);
});
it('restricts extraction requests to known YouTube origins', async () => {
   const fetcher = serverFetch(new AbortController().signal);
   await expect(fetcher('https://localhost/private')).rejects.toThrow('Unsupported extraction origin');
});
it('does not contact YouTube for an unsigned download', async () => {
   const response = await SELF.fetch('https://example.com/media?ticket=unsigned');
   expect(response.status).toBe(403);
   expect(fetch).not.toHaveBeenCalled();
});
