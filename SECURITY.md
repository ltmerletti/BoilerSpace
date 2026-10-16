# Security policy

Security fixes target the current `main` branch. This project does not currently maintain separate supported release branches or promise a response deadline.

## Report a vulnerability

Use [GitHub's private vulnerability reporting form](https://github.com/ltmerletti/BoilerSpace/security/advisories/new) when it is available. If the repository does not offer private reporting, open a minimal issue asking the maintainer for a private contact channel. Do not put exploit details, credentials, or private course data in that public request.

Include the affected commit, browser/version, reproduction steps, impact, and a minimal example using synthetic or redacted data. Relevant issues include unintended disclosure of course data or credentials, reading material without the expected access checks, and course text causing the assistant to act outside its intended behavior.

Never send Purdue passwords, session cookies, live API keys, signed document URLs, or a full authenticated browser profile with a report. If a key has already been exposed, revoke it at GenAI Studio; disconnecting BoilerSpace only removes its local copy.

Ordinary sync failures, missing syllabi, and interface bugs belong in [GitHub Issues](https://github.com/ltmerletti/BoilerSpace/issues). See [PRIVACY.md](PRIVACY.md) for the data the extension stores and sends.
