# TransitOS — Product Requirements

**Scope:** what we are building, for whom, and why — distilled from the market research in `idea.md` (which remains the raw source, including citations). For technical design see `ARCHITECTURE.md`; for build state see `SESSION-HANDOFF.md`.

---

## 1. What TransitOS is

A **school-transport operating system** for Indian schools, beginning with Kerala: one platform that runs the entire transport operation — students, guardians, routes, stops, vehicles, drivers, trips, attendance, safety, fees, and parent communication — rather than a bus-tracking app.

**Positioning, stated as a boundary:** we are not competing on "where is the bus?". Live GPS tracking is commoditised; several vendors ship it, and in Kerala the state's own Motor Vehicles Department already gives parents a free tracking app (Vidhya Vahan, 50K+ downloads). Competing there means competing with free, government-backed software on its strongest feature.

What no one has closed well is the **operational and financial workflow around** the bus: route assignment driving fee calculation, verified boarding and drop-off, substitutions when a bus breaks down, compliance documents that expire, and the transport office's phone ringing all morning. That is the product.

---

## 2. Who buys it, and why they'd switch

**Buyer:** the principal, school management, or transport coordinator — not the individual parent.

**Target segment:** private, CBSE/ICSE and larger state-board schools with roughly 500–3,000 students operating real fleets, plus independent operators running transport for several schools. Kerala first (≈3,000 private unaided schools, high digital adoption, an existing state push toward transport visibility), then wider India.

**The pitch is ROI, not features:** fewer "where is the bus?" calls to the office, no manual attendance registers, transport fees collected automatically instead of chased, verified boarding and drop-off records when a parent disputes something, minutes rather than hours to reassign a driver or substitute a vehicle, and compliance expiries surfaced before an RTO check rather than after.

Competing on per-student price is explicitly a losing strategy — incumbents already publish very low per-student rates. Compete on operational control.

---

## 3. Non-negotiable constraints

**This system processes children's personal and real-time location data.** That is the defining constraint, not a compliance checkbox:

- India's DPDP Act requires verifiable parental consent for processing children's data and restricts tracking and behavioural monitoring.
- A parent may see only their own child. A driver may see only today's assigned trip. An attendant only that trip's students. A school admin only their own school. Platform staff get **time-limited, school-approved, audited** access — never standing access to any school's data.
- Data minimisation is a product rule: no Aadhaar, caste, religion, or biometrics. Medical/emergency fields are optional and separately encrypted.
- Notifications must not leak location: "Your child has boarded today's bus", never "Aisha boarded at 7:14 at XYZ Street".

Privacy here is also commercially useful — it is a differentiator when selling to premium schools.

**Kerala-specific operational realities** the system must model rather than assume away: Malayalam alongside English throughout; mixed fleets (school-owned, contracted operators, and parent-arranged vehicles); monsoon disruption (blocked roads, paused routes, reassigned stops); and a calendar of hartals, bandhs, local holidays, exam days and working Saturdays that makes "Monday–Friday as normal" wrong.

---

## 4. Delivery plan — eight sub-projects

The full platform is far too large for one specification. It is decomposed so each piece is independently buildable and testable, and each gets its own spec → plan → implementation cycle.

| # | Sub-project | Status |
|---|---|---|
| **1** | **Foundations** — repo, identity, auth (Argon2id + MFA), RBAC, multi-tenant isolation via Postgres RLS, audit logging | **in progress** |
| 2 | Core transport backend + Admin web — students, guardians, vehicles, drivers, routes, stops, trip state machine; permission engine; feature flags | not started |
| 3 | Realtime GPS — telemetry ingestion, Redis live state, PostGIS history, retention windows, spoof/impossible-jump rejection | not started |
| 4 | Driver app (Flutter) — offline-first attendance, encrypted local storage, device registration | not started |
| 5 | Parent app (Flutter) — live tracking scoped to an active trip, event notifications, absence requests, authorised pickup with OTP, consent capture | not started |
| 6 | Fees & payments — distance-slab tariff engine, invoices, UPI/Razorpay, refunds, route-change adjustments | not started |
| 7 | Notifications, compliance vault, incidents — push/WhatsApp/SMS hierarchy, document expiry alerts, SOS and breakdown workflows | not started |
| 8 | Platform operations & compliance — security monitoring, support-access workflow, backup/DR, retention automation, DPDP export/delete | not started |

Sub-project 1 is the substrate everything else builds on; it deliberately ships no product features.

### Separate deliverable — marketing landing page (not yet started)

A public landing page for TransitOS, to be built **after** the platform work above. It is tracked separately rather than as a ninth sub-project: different audience, different stack (a static marketing site), and no dependency on the platform's architecture.

It is worth writing down now what it must argue, because that reasoning is already settled in this document and should not be re-derived from scratch later:

- **Audience is the buyer, not the end user** — principals, school management, and transport coordinators. Not parents, who are users of the product but not purchasers of it.
- **Lead with ROI and operational control, never "we have GPS."** Tracking is commoditised and, in Kerala, the state gives it away free. The page must open on the operational pain: transport-office phone calls, manual attendance registers, fees chased by hand, no verified record when a parent disputes a drop-off, and a breakdown that takes an hour to re-route.
- **Position against bundling.** The competitive claim is transport *depth*, not feature count — the opposite of the all-in-one ERPs whose transport module is one tab among thirty.
- **Privacy as a selling point, not fine print.** This system handles children's location data; the isolation guarantees, DPDP-readiness, consent records, and time-limited support access are commercially persuasive to premium schools, not just legally necessary.
- **Kerala-first framing**, with Malayalam and English both first-class.
- Concrete proof beats adjectives: the verified boarding/drop-off record, the substitute-driver flow, and compliance expiry alerts are the demos worth showing.

---

## 5. The workflow the product is optimised around

Every design decision should be checked against this single journey:

```
Morning:  driver starts trip → parent notified → bus nears stop → parent gets ETA
          → student boards → attendance recorded → parent gets confirmation
          → bus reaches school → parent gets arrival confirmation

Afternoon: school dispatches → student boards → bus nears home stop → parent gets ETA
          → authorised person collects (OTP if unknown) → student marked dropped
          → parent gets confirmation
```

Two supporting properties matter as much as the happy path: **honest state** (if GPS is stale, say "last updated 3 min ago" — never animate a bus that is not moving) and **offline tolerance** (the driver app must record attendance without connectivity and sync later, with event ids that make duplicate submissions harmless).

---

## 6. MVP priorities

**P0** — school onboarding; students and guardians; vehicles; drivers and attendants; routes and stops; trips; driver GPS; parent live tracking; ETA; boarding/deboarding; absence requests; notifications; payments; receipts; fee configuration; SOS.

**P1** — route deviation and overspeeding alerts; compliance documents; substitute vehicle and driver; WhatsApp; RFID/QR attendance.

**P2/P3** — CCTV, advanced route optimisation, fuel management, predictive analytics, AI assistant.

**Explicitly not in the MVP,** because bundling breadth is how the incumbents became shallow: AI route optimisation, facial recognition, computer vision, CCTV streaming, predictive maintenance, payroll, full school ERP, academics, exams, LMS, hostel, library, biometric attendance, marketplace. The advantage is **transport depth, not feature count**.

---

## 7. Commercial shape

Annual per-school licensing rather than per-student undercutting — roughly ₹15–30k (small fleet), ₹40–75k (mid-size school), ₹1L+ (large school or group), with GPS hardware, messaging usage, RFID/NFC devices, payment processing, and multi-campus billed separately.

Phase 1 targets 6–10 Kerala pilot schools. The larger prize is Phase 3: a single operator running transport for many schools from one account — which turns independent school-bus contractors into customers — and then India-wide expansion with state-specific rules kept as configuration rather than forks.

---

## 8. How we'll know it worked

- Transport-office calls asking where a bus is drop sharply.
- Attendance registers stop being filled in by hand.
- Transport fee collection improves and arrears become visible rather than discovered.
- Every boarding and drop-off is a verifiable record.
- A breakdown or a sick driver is handled in minutes without rebuilding the route.
- No compliance document expires unnoticed.
- No parent can ever see another family's child.
