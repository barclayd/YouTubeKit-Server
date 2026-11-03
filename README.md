# MyTube extractor

A private Cloudflare Worker based on [YouTubeKit-Server](https://github.com/alexeichhorn/YouTubeKit-Server), using its existing YouTubeKit WebSocket protocol and `youtubei.js` extractor.

The Worker performs extraction requests itself. It returns one-hour signed media links that stream the selected video/audio through `/media`, keeping extraction and media requests on Cloudflare. Range responses and download cancellation are preserved; video bodies are streamed without being buffered or stored.

`/v1` requires an `Authorization: Bearer ...` header. `/media` requires a valid HMAC ticket for an HTTPS `*.googlevideo.com` URL. Extraction origins and redirects are restricted, and each authenticated app is limited to 200 extractions per day and 1,000 per week. App IDs identify rate-limit buckets; the bearer token provides authentication.

YouTube can still refuse server-originated requests. A working Worker does not guarantee that every video or future request will be accepted.

## Deploy

```sh
npm ci
npm run typecheck
npm test -- --run
npm run deploy -- --secrets-file /absolute/path/to/private-secrets.json
```

The private JSON file needs two independently generated random values named `ACCESS_TOKEN` and `MEDIA_SIGNING_KEY`. Keep it outside the repository. `ACCESS_TOKEN` authenticates the app; `MEDIA_SIGNING_KEY` stays on the Worker. Use the generated workers.dev URL and access token in the app's ignored `PrivateRemote.xcconfig`.

`wrangler.mytube.jsonc` is the deployment config. The original upstream `wrangler.toml` remains for reference. Local tests use the newest compatibility date supported by the published test runner (August); the deployed November runtime is checked separately.

## App integration

Use YouTubeKit's `.remote(serverURL:)` method and pass the bearer header on its WebSocket request. This fork adds an optional `video_title` to each remote stream so a failed local metadata request does not stop extraction or trigger another phone-side request. Older YouTubeKit clients ignore that field; the MyTube vendored client reads it.

The server emits no client-side `urlRequest` packets in this configuration. It performs the network calls on Cloudflare and sends the final stream list. The client still handles preroll availability and combines separate video/audio tracks locally.
