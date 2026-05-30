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

> **Access model — the CEO's private all-access Atlas.** This bot is NOT a
> shared, per-business tool. It serves the OWNER (the CEO) and ONLY the owner:
> it answers a single Microsoft identity and HARD-REFUSES everyone else
> (fail-closed — if no owner is configured it refuses all users). For the owner
> it spans everything: all three businesses plus a personal space, merged into
> one answer. Cross-entity isolation still lives in the brain's data layer; this
> bot is the sanctioned superuser above it. Two layers of lock protect it: the
> single-tenant registration (only your org can reach the bot) and the owner-id
> gate (only YOU, by Object ID / UPN, get answers). Step 5 sets that owner id.

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
   - `ATLAS_OWNER_AAD_OBJECT_ID` — YOUR Microsoft identity (the owner gate).
     Find it in **Azure Portal → Microsoft Entra ID → Users → (your user) →
     Object ID**. This is the stable, tenant-scoped id and is the preferred
     match.
   - `ATLAS_OWNER_UPN` (optional convenience fallback) — your user principal
     name / sign-in email, e.g. `tle@gainmanagement.com`.

   **Why an owner id, not a conversation map:** this bot is YOUR private
   all-access Atlas, not a per-business tool. It answers only the owner identity
   and refuses everyone else; for the owner it spans all businesses + personal.
   Set at least one of the two fields (Object ID preferred). **Fail-closed:** if
   NEITHER is set, the bot refuses ALL users — so a missing owner id locks
   everyone out rather than letting anyone in.

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
