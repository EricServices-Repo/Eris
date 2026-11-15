# Security policy

## Supported versions

Security fixes go into the latest release. Eris updates itself from [GitHub Releases](https://github.com/EricServices-Repo/Eris/releases), so stay on the newest version.

| Version | Supported |
| ------- | --------- |
| Latest release | Yes |
| Older releases | No |

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: **[Report a vulnerability](https://github.com/EricServices-Repo/Eris/security/advisories/new)** (Security tab → Advisories). Don't open a public issue or use in-app feedback for security reports, because those create public issues.

Include the Eris version, your OS, steps to reproduce, and what an attacker could do. You'll get an acknowledgement on the advisory, and the fix will ship in a new release.

Areas of particular interest:

- agent tool execution and command approval;
- workspace trust;
- credential storage;
- the IPC boundary between the renderer and the main process;
- the update feed.
