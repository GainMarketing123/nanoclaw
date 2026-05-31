// Channel self-registration barrel file.
// Each import triggers the channel module's registerChannel() call.

// discord

// gmail

// slack

// teams
import './teams.js';

// telegram — DECOMMISSIONED 2026-05-30. Microsoft Teams is now the CEO's sole
// full-access Atlas. The telegram channel module and TELEGRAM_* env are left
// intact; re-enable simply by uncommenting the import below. Without this
// import the channel never self-registers, so it never connects or polls
// (also ends the duplicate-getUpdates 409 churn).
// import './telegram.js';

// whatsapp
