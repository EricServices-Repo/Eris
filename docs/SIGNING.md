# Code signing Eris releases

Reviewed against integrated `main` `0a54629` on 2026-11-01. Package version: **0.6.10**; published tag `v0.6.10` is the older immutable `f14e409` source. Later source changes require another build.

CI (`.github/workflows/release.yml`) signs installers when the secrets below are present.
Without them, builds succeed **unsigned** (fine for local testing; not for production auto-update).

## Windows (Authenticode)

### 1. Get a certificate

- **OV** or **EV** code-signing certificate from DigiCert, Sectigo, SSL.com, etc.
- Certificate possession/signing does not by itself establish SmartScreen acceptance; the repository does not qualify download reputation or installation behavior.
- Export (or receive) a `.pfx` / `.p12` and password.  
  Cloud HSM / Azure Key Vault / DigiCert KeyLocker need a different CI integration — this doc covers a standard PFX.

### 2. Encode for GitHub Actions

On macOS/Linux:

```bash
base64 -i ErisWindows.pfx | tr -d '\n' > win-cert.b64
# Do not commit win-cert.b64 — only paste into a secret
```

On Windows (PowerShell):

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("ErisWindows.pfx")) | Set-Clipboard
```

### 3. Repo secrets (`EricServices-Repo/Eris`)

Set **either** pair:

| Secret | Value |
|--------|--------|
| `WIN_CSC_LINK` | Base64 of the `.pfx`, **or** `https://…` URL to the file, **or** a path if you restore it in the job |
| `WIN_CSC_KEY_PASSWORD` | PFX password |

**or**

| Secret | Value |
|--------|--------|
| `WINDOWS_CERT_PFX_BASE64` | Base64 of the `.pfx` |
| `WINDOWS_CERT_PASSWORD` | PFX password |

CI maps these to electron-builder’s `CSC_LINK` / `CSC_KEY_PASSWORD` on the Windows job only.

### 4. Verify a release build

On a Windows machine after installing or extracting the signed setup:

```powershell
Get-AuthenticodeSignature .\Eris-*-win-x64-setup.exe
# Status should be Valid
```

SmartScreen may still warn for a while on new publishers until reputation builds.

---

## macOS (Developer ID + notarize)

Already wired. Secrets:

| Secret | Value |
|--------|--------|
| `MAC_CERT_P12_BASE64` | Base64 of **Developer ID Application** `.p12` |
| `MAC_CERT_PASSWORD` | P12 password |
| `APPLE_ID` | Apple ID email |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password |
| `APPLE_TEAM_ID` | 10-character Team ID |

Local `npm run dist:mac` / `dist:dmg` force unsigned (`identity=null`). Use tagged CI releases for signed Mac builds.

```bash
codesign -dv --verbose=4 dist/mac-arm64/Eris.app
spctl -a -vv dist/mac-arm64/Eris.app
```

---

## Checklist

- [ ] Windows `WIN_CSC_*` or `WINDOWS_CERT_*` secrets set  
- [ ] Mac `MAC_CERT_*` + Apple notarization secrets set  
- [ ] Tag a release (`v*`) and confirm CI logs say signing is enabled  
- [ ] Confirm `Get-AuthenticodeSignature` / `codesign` / `spctl` on artifacts  

## Verification boundary

The release workflow selects configured certificate inputs and records signing state in per-platform provenance. Repository configuration does not establish that the secrets exist, a notarization succeeded, or an installed update was accepted by Gatekeeper/SmartScreen. Verify those properties on the actual artifact and target OS. Never commit certificate exports, passwords or local signing scratch files. See [release/update design](UPDATES.md) for immutable-source and manual-install fallback behavior.
