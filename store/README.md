# Caido Store submission materials

This folder contains everything you need to open a PR against
[caido/store](https://github.com/caido/store).

| File | Purpose |
|------|---------|
| [`plugin_packages.entry.json`](./plugin_packages.entry.json) | Entry to append to `plugin_packages.json` |
| [`../public.pem`](../public.pem) | Ed25519 public key (safe to commit) |

> **Private key** lives only as local `private.pem` (gitignored).  
> Paste its full contents into the GitHub secret `PRIVATE_KEY`.

See [../docs/PUBLISHING.md](../docs/PUBLISHING.md) for the full step-by-step.
