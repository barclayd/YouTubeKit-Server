/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import { authorized, mediaURL, relayMedia, serverFetch } from './media-proxy';
import { YouTubeService } from './youtube/service';
export { AppRateLimiter } from './durable-objects/app-rate-limiter';
import { RateLimitDecision } from './durable-objects/app-rate-limiter';

const APP_ID_HEADER = 'X-AppID-v1';
const APP_ID_MAX_LENGTH = 128;

export default {
   async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      const url = new URL(request.url);

      if (url.pathname === '/media') return relayMedia(request, env.MEDIA_SIGNING_KEY);
      const appID = normalizeAppID(request.headers.get(APP_ID_HEADER));

      // Only handle GET /v1?videoID=... as WebSocket upgrades
      if (url.pathname === '/v1' && request.headers.get('Upgrade') === 'websocket') {
         if (!await authorized(request, env.ACCESS_TOKEN)) return new Response('Unauthorized', { status: 401 });
         try {
            const decision = await checkRateLimit(appID, env);
            if (!decision.allowed) {
               console.warn(
                  'Rate limit rejected request',
                  JSON.stringify({
                     appID,
                     path: url.pathname,
                     limitDay: decision.limitDaily,
                     remainingDay: decision.remainingDaily,
                     limitWeek: decision.limitWeekly,
                     remainingWeek: decision.remainingWeekly,
                     retryAfterSeconds: decision.retryAfterSeconds,
                  })
               );
               return buildRateLimitResponse(decision);
            }
         } catch (error) {
            console.error('Rate limiter unavailable:', error);
            return new Response('Rate limiter unavailable', { status: 503 });
         }

         const videoID = url.searchParams.get('videoID');
         if (!videoID || !/^[A-Za-z0-9_-]{11}$/.test(videoID)) {
            return new Response('Missing videoID', { status: 400 });
         }

         const [clientSock, serverSock] = Object.values(new WebSocketPair());

         // accept and handle on server side
         serverSock.accept();

         const abort = new AbortController();
         serverSock.addEventListener('close', () => abort.abort());
         const youtubeService = new YouTubeService(videoID, serverSock, {
            fetcher: serverFetch(abort.signal),
            mapStream: async stream => ({ ...stream, url: await mediaURL(url.origin, stream.url, env.MEDIA_SIGNING_KEY) }),
         });
         ctx.waitUntil(youtubeService.start());

         return new Response(null, { status: 101, webSocket: clientSock });
      }

      return new Response('Not found', { status: 404 });
   },
} satisfies ExportedHandler<Env>;

function normalizeAppID(rawAppID: string | null): string {
   const trimmed = rawAppID?.trim();
   if (!trimmed) {
      return 'unknown';
   }

   return trimmed.slice(0, APP_ID_MAX_LENGTH);
}

async function checkRateLimit(appID: string, env: Env): Promise<RateLimitDecision> {
   const objectID = env.APP_RATE_LIMITER.idFromName(appID);
   const rate_limiter = env.APP_RATE_LIMITER.get(objectID);
   return await rate_limiter.admit({ cost: 1, nowMs: Date.now() });
}

function buildRateLimitResponse(decision: RateLimitDecision): Response {
   return new Response('Too many requests', {
      status: 429,
      headers: {
         'Retry-After': decision.retryAfterSeconds.toString(),
         'X-RateLimit-Limit-Day': decision.limitDaily.toString(),
         'X-RateLimit-Limit-Week': decision.limitWeekly.toString(),
         'X-RateLimit-Remaining-Day': decision.remainingDaily.toString(),
         'X-RateLimit-Remaining-Week': decision.remainingWeekly.toString(),
      },
   });
}
