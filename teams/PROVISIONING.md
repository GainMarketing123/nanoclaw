# Teams Channel — Provisioning Runbook (THE WALL)

This is the remaining LIVE work that needs Azure / Microsoft 365 admin access.
Everything in the codebase is already built and tested; the Teams channel is
**dormant** until step 7 flips the on-switch. None of these steps touch the
live Telegram bot.

Do these in order. Verified against Microsoft Learn docs (abs-quickstart /
channel-connect-teams, updated 2025-12-16).

> **MUST be single-tenant.** Microsoft deprecated *multi-tenant* bot creation
> after 2025-07-31, so new bots are single-tenant. That fits us — all
> businesses live in one M365 tenant. The code declares
> `MicrosoftAppType: 'SingleTenant'`; the registration must match.

## 1. Create the Azure Bot resource (this also creates the app identity)

1. Azure Portal → **Create a resource** → search `bot` → select the
   **Azure Bot** card → **Create**.
2. **Project details:** name the bot (e.g. `atlas-teams`), pick the
   subscription + resource group, leave data residency global.
3. **Microsoft App ID:** choose **Type of App = Single Tenant**, and
   **Creation type = Create new Microsoft App ID**.
4. **Review + create** → **Create**. Azure provisions the app registration and
   an initial password for you.

## 2. Collect the three credential values

1. Open the new Azure Bot resource → **Settings → Configuration**.
2. Copy **Microsoft App ID** → `MICROSOFT_APP_ID`.
3. Copy **App Tenant ID** → `TEAMS_BOT_TENANT_ID`.
4. Click **Manage** (next to Microsoft App ID) → **Certificates & secrets** →
   **New client secret** → copy the secret **Value** immediately (it is hidden
   after you leave the page) → `MICROSOFT_APP_PASSWORD`.

## 3. Set the messaging endpoint + add the Teams channel

1. Still on **Configuration**, set **Messaging endpoint** to
   `https://<vps-domain>/api/messages` → **Apply**.
2. **Channels** → **Microsoft Teams** → agree to the terms → on the
   **Messaging** tab pick the Azure (public) cloud → **Apply**.

## 4. Route the endpoint on the VPS

1. Add a Caddy rule that forwards the public messaging endpoint to the local
   adapter port:

   ```
   reverse_proxy /api/messages localhost:3978
   ```

   `3978` is `TEAMS_ADAPTER_PORT` (change both if you use a different port).

## 5. Put the secrets in place

1. Add to the secrets env (`nanoclaw/.env`):
   - `MICROSOFT_APP_ID`
   - `MICROSOFT_APP_PASSWORD`
   - `TEAMS_BOT_TENANT_ID`
   - `TEAMS_ENTITY_MAP` — a JSON object mapping each business's Team /
     conversation id to its entity slug, e.g.
     `{"19:abc@thread.v2":"gpg","19:def@thread.v2":"wisestream"}`.

   **Why per-conversation:** all businesses share ONE M365 tenant, so the
   tenant ID can't tell businesses apart. The conversation map is the real
   guardrail — any unmapped conversation is refused so one business can never
   read another's memory.

## 6. Build and upload the Teams app package

1. Copy `teams/manifest.template.json` and replace `${BOT_APP_ID}` with the
   Application (client) ID.
2. Zip the manifest together with `color.png` and `outline.png` icons.
3. Upload via Teams Admin Center / Developer Portal.

## 7. THE ON-SWITCH

Add this line to `src/channels/index.ts`:

```ts
import './teams.js';
```

Then rebuild and deploy nanoclaw. Until that import exists the Teams channel is
**dormant** and the live Telegram bot is completely unaffected.

---

**Note (decision D9):** Telegram is retired LAST — only after Teams is proven
in production. Both channels run side by side during the transition.
