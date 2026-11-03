import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: './wrangler.mytube.jsonc' },
            // The published test runner currently supports dates only through August.
            // Exercise the deployed November runtime separately with the live checks.
            miniflare: { compatibilityDate: '2026-08-22', bindings: { ACCESS_TOKEN: 'test-token', MEDIA_SIGNING_KEY: 'test-signing-key' } },
		}),
	],
});
