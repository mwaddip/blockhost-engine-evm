# Privilege Separation

The monitor service runs as the unprivileged `blockhost` user. Operations that require root (iptables, writing key files to `/etc/blockhost/`, saving addressbook) are delegated to a separate **root agent daemon** (provided by `blockhost-common`) via a Unix socket at `/run/blockhost/root-agent.sock`.

## Protocol

The TypeScript client (`src/root-agent/client.ts`) communicates using length-prefixed JSON (4-byte big-endian length + JSON payload).

## Available Actions

| Action | Description |
|--------|-------------|
| `iptables-open` | Add an ACCEPT rule for a port |
| `iptables-close` | Remove an ACCEPT rule for a port |
| `generate-wallet` | Generate a keypair, save key to `/etc/blockhost/<name>.key`, update addressbook |
| `addressbook-save` | Write addressbook entries to `/etc/blockhost/addressbook.json` |
| `qm-start` | Start a Proxmox VM by VMID |

The systemd service (`examples/blockhost-monitor.service`) declares a dependency on `blockhost-root-agent.service` and runs with `NoNewPrivileges=true` and `ProtectSystem=strict`.
