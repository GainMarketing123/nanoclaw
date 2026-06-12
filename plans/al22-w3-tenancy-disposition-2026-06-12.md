# al22 wave-3 — registration-tenancy review spiral: disposition + carry-overs (2026-06-12)

## What happened

The wave-3 landing's review chain converged everywhere except ONE area:
`src/db.ts` `setRegisteredGroup` registration-tenancy semantics. Three
consecutive rounds, each accepting the previous fix and widening the demand on
the same path — the spec-spiral signature (BEHAVIORS §1.5, walk back at 3
same-area rounds):

1. 66873e9 (soft, prior landing's range review): same-JID folder-rename left
   `scheduled_tasks.group_folder` + `sessions.group_folder` stranded.
   → FIXED in a98b146 (tasks migrate, vacated folder's session cleared).
2. a98b146 (FAIL_BLOCKING): the complement — a stale session at the
   DESTINATION folder let an incoming tenant resume another tenant's
   conversation. → FIXED in 1d25779 (destination sessions row cleared on any
   tenant-JID change; migration ordering fixed with it).
3. 2dc3451 (FAIL_BLOCKING, landing tip): two NEW, broader demands on the same
   function — dispositioned below, not chased.

Everything else at the tip drew zero findings: the seed-orchestrator reland,
the shared deliverability contract, the host-task fail-closed issuer, the
briefing rewrite, and the quality-check telemetry chain all converged.

## Round-3 findings, verbatim dispositions

### Finding 1 — on-disk `.claude` residue on tenant change (state_mutation, blocking)

"Destination-folder takeover clears only the `sessions` row, but leaves the
old tenant's on-disk Claude state mounted under the same folder"
(`data/sessions/<folder>/.claude`).

DISPOSITION: REAL, PRE-EXISTING, and strictly NARROWED by this landing —
BOARDED as a carry-over, not patched here.

- Pre-existing: before this landing, a folder takeover inherited BOTH the DB
  session pointer (with automatic resume of the prior tenant's conversation)
  AND the on-disk files. This landing removed the pointer/auto-resume; the
  passive file residue remains, as it always has.
- The right fix is a cross-layer design decision, not a `db.ts` patch:
  `db.ts` must not delete container filesystem state it does not own
  (`container-runner.ts` builds/mounts that directory). Candidate designs:
  key the session store by tenant (jid+folder) instead of folder alone, or
  rotate `data/sessions/<folder>/.claude` at spawn/registration on tenant
  change.

### Finding 2 — scheduled-task ownership on same-folder JID change (state_mutation, blocking)

"Folder-tenant replacement keeps the displaced tenant's scheduled tasks and
silently reassigns them to the incoming JID."

DISPOSITION: relitigates an ALREADY-LANDED, ALREADY-REVIEWED design — NOT
TAKEN.

- The `scheduled_tasks.chat_jid` repoint on re-registration is the
  origin/main baseline (commit 0a03854, present in ae8ac535), itself the fix
  for a prior wave's FAIL_BLOCKING ("scheduler keeps routing output to the
  now-dead old JID").
- The system's tenancy model: the FOLDER is the durable group identity — it
  carries the group's memory (`groups/<folder>/CLAUDE.md`), host-task policy,
  and IPC namespace. The JID is the mutable channel ADDRESS. A folder's tasks
  therefore follow the folder's current address by design; a channel
  re-registration (e.g. a re-paired WhatsApp group with a fresh JID) must NOT
  orphan the group's cron jobs.
- First-occurrence objection in the fifth review pass over this function in
  this landing alone (e6dde1a, 863a951, 727e4d6, a98b146 all examined
  `setRegisteredGroup` without raising it).
- The one sub-case with genuine ambiguity — a same-JID rename INTO an
  occupied folder merges the two folders' task sets — is an operator-initiated
  folder takeover; its task semantics is a policy question. Boarded together
  with finding 1 as the registration-tenancy carry-over.

## Carry-over (for boarding)

ONE design item: **registration-tenancy hardening** — decide the tenancy
model explicitly (folder-is-identity vs jid-is-identity), then in one slice:
per-tenant session storage (or spawn-time `.claude` rotation on tenant
change) + explicit task-ownership semantics for folder takeover. Until then:
the write layer permits folder takeover by design; the DB session pointer is
cleared on tenant change (this landing); passive `.claude` file residue and
task adoption on takeover match the pre-landing baseline.

## Range verdict handling

The range cert for this landing (ae8ac535..tip) is issued
`acknowledged=True` against the 2dc3451 FAIL_BLOCKING with the dispositions
above; the ack-file entry carries the same rationale.
