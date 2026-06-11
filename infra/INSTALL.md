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

NOTE: the live unit also carries `atlas-user-split.conf` (User=nanoclaw-he
override) as a VPS-only drop-in — that one is owned by the 1.A.6 Phase 3.2
arc and is intentionally not sourced here yet.

## Source-vs-live parity check

```bash
for f in nanoclaw.service.d/host-task-hmac.conf atlas-host-executor.service.d/host-task-hmac.conf; do
    echo "=== $f ==="
    diff <(ssh atlas@5.78.190.56 "cat /etc/systemd/system/$f") \
         "$(git rev-parse --show-toplevel)/infra/systemd-dropins/$f" || echo "DRIFT: $f"
done
# /etc/atlas is x-only traverse for atlas; the 0644 policy file is readable by name:
ssh atlas@5.78.190.56 'cat /etc/atlas/host-task-policy.json' | \
    diff - "$(git rev-parse --show-toplevel)/infra/host-task-policy.json" || echo "DRIFT: policy"
```

Empty diff = parity.
