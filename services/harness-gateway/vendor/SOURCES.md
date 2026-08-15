# Vendored Harness plugin sources

The only two plugins promoted from the isolated plugin lab into the AMS
Harness profile. Copied from the local isolated package cache — no remote
installation. High-risk lab plugins stay unpromoted.

| Package | Version | Upstream repository | Upstream commit | Local tarball | SHA-256 |
|---|---|---|---|---|---|
| `@omdsh-dev/dsh-genui` | 0.8.3 | https://github.com/omdsh-dev/dsh-genui.git | `0e756efb7671e6b8413dde3d8e199c68fa89cbeb` | `E:\projects\_ams_harness_plugin_lab\packages\omdsh-dev-dsh-genui-0.8.3.tgz` | `5849c50e475c995ca891b8089605fc8f85d91ab5c6c9d969367eedaaa22ef871` |
| `@dsh-external/dsh-visualize` | 0.1.2 | https://github.com/Nagi-ovo/dsh-visualize.git | `e3254f762cbe4dbf796eca05d73a293f0e8e4a87` | `E:\projects\_ams_harness_plugin_lab\packages\dsh-external-dsh-visualize-0.1.2.tgz` | `fc923de7b5f899c8d82d891fad24c42ab3d14517ea92d9051da98dfbe92d4acc` |

- `init-profile.mjs` re-verifies the exact pinned version from each package
  manifest on every profile bootstrap and aborts on mismatch.
- `lib/*.js` files carry an added `/* eslint-disable */` first line so the
  vendored third-party bundles stay outside this repository's lint rules;
  nothing else is modified.
- Lab registry/security evidence:
  `E:\projects\AI Marketing Studio Control Center\runtime\harness-plugin-lab`.
