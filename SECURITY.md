# Security Policy

`pi-sidebar` is a package for the pi coding harness.

## Reporting a Vulnerability

Please report suspected vulnerabilities through GitHub's private vulnerability reporting for this repository when available, or by opening a minimal GitHub issue that does not include exploit details or secrets.

Do not post API keys, tokens, private repository paths, or other sensitive data in public issues.

## Scope

The package runs as a pi extension and therefore executes with the same local permissions as the pi process. Review extension source before installing any pi package.

`pi-sidebar` runs static `git` commands through pi's `pi.exec` helper and displays git metadata such as branch names, file paths, and diff counts. It does not intentionally read file contents, environment variable values, or credential files.
