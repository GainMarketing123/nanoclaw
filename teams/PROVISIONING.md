# Teams Channel — Provisioning Runbook (THE WALL)

This is the remaining LIVE work that needs Azure / Microsoft 365 admin access.
Everything in the codebase is already built and tested; the Teams channel is
**dormant** until step 7 flips the on-switch. None of these steps touch the
live Telegram bot.

Do these in order.

## 1. Register the bot app in Azure

1. Azure Portal → **App registrations** → **New registration**.
2. Copy the **Application (client) ID** → this is `MICROSOFT_APP_ID`.
3. Go to **Certificates & secrets** → **New client secret** → copy the secret
   **value** (not the ID) → this is `MICROSOFT_APP_PASSWORD`.
4. Copy the **Directory (tenant) ID** → this is `TEAMS_BOT_TENANT_ID`.

## 2. Create the Azure Bot resource

1. Azure Portal → **Azure Bot** → **Create**.
2. Use the Application (client) ID from step 1.
3. Set the **messaging endpoint** to `https://<vps-domain>/api/messages`.

## 3. Add the Teams channel

1. In the Azure Bot resource → **Channels** → add **Microsoft Teams**.

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
