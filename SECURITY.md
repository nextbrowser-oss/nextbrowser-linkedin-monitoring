# Security Policy

## Supported scope

Security fixes target the repository's default branch. This repository contains the LinkedIn monitoring engine used by Nextbrowser: the page scripts it evaluates on linkedin.com, its state handling, the nbc adapter, and the `linkedin-monitor` CLI.

The Nextbrowser desktop application, the nbc/nextctl CLI, and the browser runtime are separate projects with their own reporting channels.

## Report privately

Do not disclose a suspected vulnerability in a public issue, discussion, pull request, or comment.

Submit reports through GitHub's private vulnerability reporting:

https://github.com/nextbrowser-oss/nextbrowser-linkedin-monitoring/security/advisories/new

A useful report includes:

- the affected file, function, or command;
- impact and required preconditions;
- reproducible steps or a minimal proof of concept;
- suggested mitigations, if known;
- whether the issue has been disclosed elsewhere.

Examples in scope:

- a page script that content on linkedin.com — a post, a comment, a name, a headline — can make run attacker-controlled code;
- a script that changes anything on the account: a reaction, a comment, a connection request, a message, a click;
- a path that sends session data, cookies or state anywhere but the host;
- state or log file handling that exposes data to other local users.

If the issue belongs to the Nextbrowser app, report it through [the app's advisory form](https://github.com/nextbrowser-oss/nextbrowser-app/security/advisories/new).

## Responsible testing

Only test systems and accounts you are authorized to test. Avoid privacy violations, service disruption, destructive actions, and access to data that is not yours. Give maintainers reasonable time to investigate and coordinate disclosure before publishing details.
