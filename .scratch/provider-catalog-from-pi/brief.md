# Task brief: derive the provider auth catalog from Pi instead of hand-writing it

## Goal

Pace Settings → Providers currently lists a hard-coded catalog of 5 providers (`PROVIDER_AUTH_CATALOG` in `packages/core/src/provider-auth.ts`). Pi 0.85.1 ships 40 providers, including **Radius** (Earendil's own gateway, API key + OAuth), which the user relies on and cannot log into from Pace today. Replace the hard-coded catalog with one derived at runtime from Pi's `ModelRuntime.getProviders()`, so Pace stays aligned with whatever providers the bundled Pi version supports. No new mechanism: `ModelRuntime` is already what `packages/backend/src/workspace/provider-auth.ts` uses for login/logout/status.

Verified facts (do not re-derive):

- `ModelRuntime.getProviders()` returns 40 `Provider` objects. Each has `id`, `name`, and `auth: { apiKey?: ApiKeyAuth; oauth?: OAuthAuth }`. `supportsApiKey = !!auth.apiKey`, `supportsOAuth = !!auth.oauth`. Type lives in `@earendil-works/pi-ai` `dist/models.d.ts`.
- Probe output from the backend package (id / name / apiKey / oauth): openai-codex is oauth-only; anthropic, github-copilot, kimi-coding, openrouter, radius, xai are both; all others are apiKey-only. Pi names differ from Pace's current labels: Pi says "OpenAI Codex" and "xAI", Pace shows "ChatGPT / Codex" and "Grok (xAI)".
- Radius OAuth emits a `select` prompt with option ids `browser` / `device-code`, then `auth_url` or `device_code` notify events. The existing `loginOAuth` handler in the backend already picks `browser` and opens the URL, so Radius login needs no new prompt handling.
- `ProviderAuthRuntime` in the backend is a `Pick<RuntimeInstance, "getProviderAuthStatus" | "login" | "logout" | "refresh">`; tests stub it. Add `getProviders` to the pick.

## Design (decided; do not re-litigate)

1. **Core (`packages/core/src/provider-auth.ts`)**: `ProviderAuthId` becomes `string`. Delete `PROVIDER_AUTH_CATALOG`. Keep a small `PROVIDER_DISPLAY_OVERRIDES` map for the two labels Pace deliberately renames (`openai-codex` → "ChatGPT / Codex", `xai` → "Grok (xAI)") and a `FEATURED_PROVIDER_ORDER` list: `openai-codex, anthropic, radius, openai, deepseek, xai, google, github-copilot, openrouter`. Export a pure `sortProvidersForDisplay(items)` that orders: configured first, then featured order, then alphabetical by label. Keep `ProviderAuthStatusItem` / `ProviderAuthStatusReport` shapes unchanged so the IPC contract does not move.
2. **Backend (`packages/backend/src/workspace/provider-auth.ts`)**: `listStatus` maps over `runtime.getProviders()`; label = override ?? `provider.name`; apply `sortProvidersForDisplay`. `assertKnownProvider` checks against the runtime's provider ids. The `supportsApiKey` / `supportsOAuth` guards in `setApiKey` / `loginOAuth` read from the runtime provider's `auth` instead of the catalog.
3. **Renderer**:
   - `apps/desktop/src/entities/provider/provider-icon.tsx`: extend the brand map with `@lobehub/icons` (5.15.0) marks for the official ids where one exists. Available names include `Bedrock, Azure, Baseten, Cerebras, Cloudflare, WorkersAI, Fireworks, GithubCopilot, Google, Gemini, VertexAI, Groq, HuggingFace, Kimi, Minimax, Mistral, Moonshot, Nvidia, OpenCode, OpenRouter, Qwen, Together, Vercel, XAI, XiaomiMiMo, ZAI, AntGroup`. For ids with no mark (radius, and anything else missing) render a neutral fallback badge with the label's first letter instead of nothing. Follow the existing Mono/Color/background/foreground pattern; tokens through the semantic bridge, no new hard-coded colours beyond brand constants from the icon package.
   - `apps/desktop/src/pages/settings.tsx`: rely on the backend order (do not re-sort). Replace the two hard-coded intro sentences ("ChatGPT/Codex, Anthropic, and Grok (xAI)…", "Paste API keys for OpenAI, Anthropic, DeepSeek, or Grok (xAI).") with wording that does not enumerate providers. On the API Key tab (now ~39 cards) add a plain text filter input above the list that matches on label or id; use an existing `shared/ui` input, no new component.
   - `apps/desktop/src/shared/runtime.ts` browser fallback and `apps/desktop/src/dev/mock/scenarios.ts`: add a `radius` entry (supportsApiKey + supportsOAuth, mode none) so the dev/browser preview shows it.
4. **Docs**: if `README.md` "Where things live" or `docs/` mentions the provider catalog as hard-coded, update the sentence. Do not write a new ADR.

## Tests (behaviour worth protecting)

- Backend `provider-auth.test.ts`: the first test currently asserts the literal 5-id list. Replace with: the report contains `radius` with `supportsApiKey && supportsOAuth`, `openai-codex` with oauth-only, and `providers.length === runtime.getProviders().length`. Add a unit test for `sortProvidersForDisplay` (configured beats featured beats alphabetical). Add a test that `setApiKey("openai-codex", …)` rejects because Pi reports no apiKey auth (guard now reads the runtime, not the catalog).
- Renderer: a test that `ProviderIcon` renders the initial-letter fallback for an unknown id (this is the new behaviour; the brand mapping itself is a literal table, do not test it). A settings test that the API-key filter narrows the cards. Keep `settings.test.tsx` mock data working; it uses `provider-api-key-anthropic`.
- Write each failing test first and watch it fail before implementing.

## Verification commands

From repo root: `bun run typecheck` (or the equivalent script in `package.json`), `bun run test` for `packages/core`, `packages/backend`, `apps/desktop`. Report real output.

## Constraints

- Work on a new branch `feat/provider-catalog-from-pi` created from `origin/main` (fetch first). Do not touch `main`.
- Commit with Conventional Commits when green; do not push, do not open a PR.
- Comments in English, why over what. Follow existing file conventions.
- Do not add a `/design` page entry unless you add a component to `shared/ui/` (you should not need to).

## Out of scope

- Model catalog / model picker changes.
- Preflight changes.
- Any new provider registration UI, custom base URLs, or `models.json` editing.
- Icon marks for providers the icon package lacks beyond the letter fallback.
