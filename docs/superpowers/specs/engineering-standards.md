# TransitOS — Engineering, Security & Privacy Standards

Status: Living reference — every sub-project spec must be checked against this
document; amend it (with a note in the amending spec) rather than forking it.
Source: consolidated from the user-provided "SYSTEMIQ TransitOS Enterprise
Security, Privacy & Engineering Standards" prompt (2026-09-05), reconciled against
`idea.md` and the Foundations design.

This is not itself an implementation plan. Each control below is tagged with the
sub-project responsible for actually building it. A control with no code yet is not
forgotten — it's scoped to land when its owning sub-project is specced.

## How to use this doc

When brainstorming a new sub-project, pull the rows tagged for it, and design to
them explicitly rather than re-deriving security requirements from scratch. When a
control turns out to conflict with YAGNI at the time (e.g. a fully generic
per-school-configurable permission engine before there are enough modules to justify
one), the sub-project's spec says so explicitly and this doc is updated to record
the deliberate deferral, not silently dropped.

## 1. Core principles (all sub-projects)

- **Security by design**: every feature assumes an attacker exists; never trust
  client-supplied data — validate and re-authorize server-side on every request.
- **Privacy by default**: collect only what's needed; a role sees only what its
  function requires (parent → own child; driver → today's assigned trip; attendant
  → that trip's students; school_admin → own school; super_admin → metadata by
  default, full access only via the time-limited support workflow, §8).
- **Zero trust**: authenticate every API call, authorize every action, log every
  privileged operation. [Foundations — Sub-project 1]

## 2. Multi-tenant isolation — [Foundations, Sub-project 1]

- Every tenant-scoped table carries `school_id`; Postgres RLS enforces it as a
  backstop to application-level scoping (see Foundations spec §3).
- Postgres schema separation: `core`, `audit` now; `transport`, `payments`,
  `analytics` reserved for the sub-projects that own that data.
- Subdomain-per-school routing (`schoolname.systemiq.in`) is an ingress/deployment
  concern layered on top of JWT-based tenant resolution — **deferred to deployment
  design**, no data-model impact.

## 3. Authentication — [Foundations, Sub-project 1 for email/password + MFA;
   OTP/social login deferred]

- Argon2id password hashing (never plaintext, never a fast general-purpose hash).
- Password policy: 12+ chars, upper/lower/number/symbol, common-password rejection,
  password history to block reuse. Enforced at signup and reset.
- TOTP-based MFA for `super_admin` and `school_admin` roles only — not driver/
  attendant/parent, where it would add login friction without a matched risk (their
  blast radius is one school or one trip, not the platform).
- Session security: short-lived JWT access tokens, rotating refresh tokens, refresh
  tokens bound to a device fingerprint, a "revoke all sessions" endpoint.
- **Deferred, tagged for later**: mobile OTP / passwordless login, Google/Microsoft
  sign-in — need an SMS/OAuth provider integration; add when a real sub-project
  needs them rather than speculatively.

## 4. RBAC / ABAC

- Coarse RBAC ships in Foundations: `super_admin`, `school_admin`, `driver`,
  `attendant`, `parent`. [Sub-project 1]
- ABAC-style scoping (parent → linked children only; driver → today's assigned trip
  only) is enforced in the domain modules that own those entities, since the rule
  only makes sense once students/trips/guardian-links exist. [Sub-project 2 for
  student/guardian scoping; Sub-project 3–4 for trip/GPS scoping]
- A **generic, per-school-configurable granular permission engine** ("toggle Create
  Route / Edit Route / Delete Route per school") is **deliberately deferred, not
  dropped** — build it once Sub-project 2 has real modules/actions to attach
  permissions to. Building a generic engine before that exists is speculative
  (YAGNI); the coarse roles above cover MVP needs.

## 5. API security

- HTTPS/TLS 1.3 only, HSTS — a deployment/infra concern, addressed when Sub-project
  1 or a later sub-project is actually deployed somewhere (not meaningful for local
  Docker Compose dev).
- Rate limiting on `/auth/*` via `@nestjs/throttler`. [Sub-project 1]
- API-key validation for GPS hardware devices (as opposed to the driver-phone
  fallback, which uses normal user auth). [Sub-project 3]
- UUIDs as public identifiers (already the Foundations convention); DTOs define
  exactly what each role's response includes — no accidental field leakage (e.g. a
  parent-facing student DTO never includes another guardian's contact info or
  internal notes). [every sub-project, enforced per-module as it's built]

## 6. GPS & location privacy — [Sub-project 3 (pipeline), Sub-project 5 (parent app)]

- Parents see only their child's assigned bus, only during an active trip; live
  location hidden once the trip ends.
- Parent-facing GPS history window: 7–30 days, configurable per school. School-level
  history: up to 1 year, configurable. Systemiq (platform) sees metadata only unless
  a support session is explicitly approved (§8).
  the schema for storage.
- Live location in Redis; historical GPS in PostgreSQL + PostGIS; archive past the
  retention window rather than delete outright where compliance needs the trail.
- Reject impossible-jump / spoofed coordinates before they reach storage.

## 7. Child data protection — [Sub-project 2 (student/guardian records), Sub-project 8 (DPDP workflows)]

- Guardian relationship and digital consent are first-class, versioned records, not
  a checkbox — consent history is retained.
- Data minimization: no religion/caste/Aadhaar/biometrics in MVP; medical/emergency
  fields (allergy, emergency contact, blood group) are optional and, when present,
  encrypted separately from the rest of the student record.

## 8. Encryption & secrets

- TLS in transit everywhere (deployment concern, see §5).
- AES-256 at rest for documents (licenses, RC, insurance) and for the
  separately-encrypted emergency fields above. [Sub-project 2 for student data,
  Sub-project 7 for compliance documents]
- Secrets only via environment variables / a secrets manager, never hardcoded —
  already a Foundations convention and a standing global rule.

## 9. Audit logging — [Foundations ships the mechanism, Sub-project 1; every later
   sub-project writes to it for its own privileged actions]

- `audit.audit_logs` is append-only: the application's DB role has no `UPDATE`/
  `DELETE` grant on it at all, not merely a "please don't" convention.
- Records actor, action, entity, old/new value where applicable, IP, device,
  timestamp.

## 10. File uploads — [Sub-project 7, compliance vault]

MIME validation, size limits, renamed on store, kept outside any public bucket,
served only via short-lived signed URLs, virus-scanned.

## 11. Payments — [Sub-project 6]

Gateway tokens only — never card/CVV/UPI PIN; webhook signature verification;
idempotent payment processing to prevent double-charging.

## 12. Offline & device security — [Sub-project 4, driver app; Sub-project 5, parent app]

Encrypted local SQLite for offline attendance queues; PIN/biometric re-auth after
inactivity; device registration with remote-revoke; SSL pinning; best-effort
root/jailbreak detection (advisory, not a hard block — many legitimate users have
rooted devices, especially in the field-driver context idea.md describes).

## 13. Notification content — [Sub-project 7]

Push/WhatsApp/SMS payloads never carry precise GPS coordinates, payment tokens, or
identifying incident detail — "Your child has boarded today's bus," not "Aisha
boarded Bus 12 at XYZ Street." Full detail lives only behind authenticated app
screens.

## 14. Security monitoring & incident response — [Sub-project 8]

Alerting on failed-login bursts, impossible-travel logins, API abuse, GPS spoofing,
route deviation. A structured incident module (accident/breakdown/medical/security/
missing-student/weather categories, timeline, photos, notifications) — this is
distinct from, and builds on, the SOS/breakdown workflows idea.md describes.

## 15. Support access — [Sub-project 8]

Systemiq support engineers get time-limited, school-approved, fully audited access
to a tenant — never standing access to any school's data.

## 16. Backup, DR & retention — [Sub-project 8]

Automated daily incremental / weekly full backups, point-in-time recovery,
monthly restore tests. Per-school-configurable retention (GPS history, attendance,
payments, audit logs each have their own default windows); deleted accounts
anonymized after their retention window rather than hard-deleted immediately.

## 17. DPDP readiness — [Sub-project 8]

Consent records, data export, account deletion workflow, anonymization, purpose
limitation, access logs, breach notification process — building on the audit-log
foundation from Sub-project 1.

## 18. DevOps & CI — [addressed per sub-project as it's built]

Protected branches, PRs, conventional commits; CI runs lint, type-check, unit +
integration tests, dependency/secret scanning. Foundations' CI (lint + test) is the
seed; security/dependency scanning steps are added as the pipeline matures rather
than gold-plated before there's a second sub-project to protect.

## 19. Mobile security — [Sub-project 4–5]

Secure token storage (Keychain/Keystore via `flutter_secure_storage`), no secrets in
the app bundle, SSL pinning, root/jailbreak advisory warning, optional screenshot
blocking on sensitive screens.

## 20. Logging hygiene — [all sub-projects]

Never log passwords, JWTs, payment tokens, or raw GPS coordinates at debug level;
mask sensitive values in any log output.
