# nanoclaw infra/ — source-to-live install reference

These files are the version-controlled SOURCE for root-owned config on the
VPS. The live installed copies may drift until a deploy lands; treat this
directory as the source of truth. Pattern mirrors
`~/.atlas-operations/systemd/INSTALL.md`.

All install commands run on the VPS in a CEO terminal with sudo. Atlas has
no sudo grant for any of these paths (by design — gate23 posture).

## Source → live path map

| Source (this repo) | Live path on VPS |
|---|---|
| `infra/host-task-policy.json` | `/etc/atlas/host-task-policy.json` |
| `infra/atlas-host-executor.service` | `/etc/systemd/system/atlas-host-executor.service` |
| `infra/systemd-dropins/nanoclaw.service.d/host-task-hmac.conf` | `/etc/systemd/system/nanoclaw.service.d/host-task-hmac.conf` |
| `infra/systemd-dropins/atlas-host-executor.service.d/host-task-hmac.conf` | `/etc/systemd/system/atlas-host-executor.service.d/host-task-hmac.conf` |
| `infra/systemd-dropins/atlas-host-executor.service.d/atlas-user-split.conf` | `/etc/systemd/system/atlas-host-executor.service.d/atlas-user-split.conf` |
| `infra/systemd-dropins/nanoclaw.service.d/oauth-shared-identity.conf` | `/etc/systemd/system/nanoclaw.service.d/oauth-shared-identity.conf` |
| `infra/sudoers.d/atlas-rsync` | `/etc/sudoers.d/atlas-rsync` |

## host-task-policy.json (SEC-1 step D — the flip)

Not a secret; world-readable is correct. The orchestrator re-reads it per
request (`src/host-task-policy.ts` `policyForGroup`), so **no restart is
needed** after install or update.

```bash
# 0. Pull latest nanoclaw on VPS so the source is present:
ssh atlas@5.78.190.56 'cd /home/atlas/nanoclaw && git pull --ff-only origin main'

# 1. Install (CEO terminal with sudo):
sudo install -m 0644 -o root -g root \
    /home/atlas/nanoclaw/infra/host-task-policy.json \
    /etc/atlas/host-task-policy.json

# 2. Eyeball:
sudo cat /etc/atlas/host-task-policy.json
```

Rollback: `sudo rm /etc/atlas/host-task-policy.json` — returns instantly to
the fail-closed deny-all posture (unknown group ⇒ no task issued). No
restart either way.

## host-task-hmac drop-ins (already live since 2026-05-25)

Both drop-ins were installed live during the 2026-05-25 supervised window;
the sources here exist so the repo matches the VPS (SEC-1 gap G2). Only
re-run this if a fresh host is being provisioned or the live drop-ins are
lost:

```bash
sudo install -d -m 0755 /etc/systemd/system/nanoclaw.service.d \
                        /etc/systemd/system/atlas-host-executor.service.d
sudo install -m 0644 -o root -g root \
    /home/atlas/nanoclaw/infra/systemd-dropins/nanoclaw.service.d/host-task-hmac.conf \
    /etc/systemd/system/nanoclaw.service.d/host-task-hmac.conf
sudo install -m 0644 -o root -g root \
    /home/atlas/nanoclaw/infra/systemd-dropins/atlas-host-executor.service.d/host-task-hmac.conf \
    /etc/systemd/system/atlas-host-executor.service.d/host-task-hmac.conf
sudo systemctl daemon-reload
```

Prerequisite: `/etc/atlas/host-task-hmac.secret` must exist root-owned 0400
(provisioned 2026-05-25; secret provisioning is CEO-supervised and is NOT
covered by this file).

## atlas-host-executor.service (main unit)

The repo unit now carries the `LoadCredential=host-task-hmac:...` line
directly (G2 parity, 2026-06-10). The live host currently gets that line
via the drop-in above instead — both at once is harmless (same credential
ID, same source path; systemd resolves to the same credential), so
installing this unit over the live one does not require removing the
drop-in. If/when this unit source is reinstalled:

```bash
sudo install -m 0644 -o root -g root \
    /home/atlas/nanoclaw/infra/atlas-host-executor.service \
    /etc/systemd/system/atlas-host-executor.service
sudo systemctl daemon-reload
# Restart via the sanctioned restart-queue, not ad-hoc systemctl.
```

## Subscription-cutover drop-ins (2026-07-11)

`atlas-user-split.conf` (previously a VPS-only Phase 3.2 drop-in) is now
sourced here: the OAuth quality-check gate reads the running user's
`$HOME/.claude/.credentials.json`, and only the nanoclaw-he credential has
a tracked refresh path (`host/refresh-claude-auth.sh`; the :15/:45
nanoclaw-he auto-refresh cron) — so the User=nanoclaw-he identity is
load-bearing for a repo-based deploy, not an optional VPS customization.

`oauth-shared-identity.conf` points the nanoclaw orchestrator (credential
proxy) at the same shared credential (CEO decision 2026-07-11, Option A:
group-readable 0640 nanoclaw-he:atlas-svc; the proxy reads, the nanoclaw-he
:15/:45 auto-refresh cron writes).

```bash
sudo install -m 0644 -o root -g root \
    /home/atlas/nanoclaw/infra/systemd-dropins/atlas-host-executor.service.d/atlas-user-split.conf \
    /etc/systemd/system/atlas-host-executor.service.d/atlas-user-split.conf
sudo install -m 0644 -o root -g root \
    /home/atlas/nanoclaw/infra/systemd-dropins/nanoclaw.service.d/oauth-shared-identity.conf \
    /etc/systemd/system/nanoclaw.service.d/oauth-shared-identity.conf
sudo systemctl daemon-reload
# Restart both services via the sanctioned restart-queue, not ad-hoc systemctl.
```

The shared credential FILE posture (0640 nanoclaw-he:atlas-svc; group-x
traverse on /home/nanoclaw-he and its .claude dir; setgid on .claude so
new files inherit the atlas-svc group) is provisioned live — secret
provisioning is CEO-supervised and NOT covered by this file. The :15/:45
refresher preserves the existing file mode on rewrite, so the 0640 posture
survives refresh cycles; its cron entry re-asserts group+mode each tick as
a backstop against foreign 0600 rewrites (e.g. the Claude CLI's own
credential save).

## Source-vs-live parity check

```bash
for f in nanoclaw.service.d/host-task-hmac.conf nanoclaw.service.d/oauth-shared-identity.conf \
         atlas-host-executor.service.d/host-task-hmac.conf atlas-host-executor.service.d/atlas-user-split.conf; do
    echo "=== $f ==="
    diff <(ssh atlas@5.78.190.56 "cat /etc/systemd/system/$f") \
         "$(git rev-parse --show-toplevel)/infra/systemd-dropins/$f" || echo "DRIFT: $f"
done
# /etc/atlas is x-only traverse for atlas; the 0644 policy file is readable by name:
ssh atlas@5.78.190.56 'cat /etc/atlas/host-task-policy.json' | \
    diff - "$(git rev-parse --show-toplevel)/infra/host-task-policy.json" || echo "DRIFT: policy"
```

Empty diff = parity.
