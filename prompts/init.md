Build and deploy **OMH Agape** at **https://agape.openmissionofhope.org**.

Agape is an Open Mission of Hope project for universal, voluntary, person-to-person assistance. Someone requests help; another person volunteers to provide it. Think “unpaid Uber for helping people.”

Tagline: **Help freely asked. Help freely given.**

Build a functional application, not merely a landing page. Inspect the existing OMH repositories, infrastructure, branding, and deployment conventions first. Reuse suitable infrastructure. Make reasonable implementation decisions and proceed autonomously. If deployment credentials or DNS access are unavailable, finish and test everything possible, then provide the exact remaining setup steps. Never claim deployment succeeded without checking the live URL.

**Purpose and principles**

Help people obtain food, groceries, temporary shelter, transportation, roadside assistance, practical help, donated items, financial assistance, and urgent bystander assistance.

Participation is voluntary. There are no compulsory exchanges, repayment obligations, bidding, or paid gigs. Welcome people regardless of religion or background. Reflect OMH’s Christian motivation through service and dignity, without making religious participation a condition of help.

Do not introduce public poverty rankings, competitive charity leaderboards, or engagement incentives around emergencies. Do not implement payment custody or money transfers in the initial release; financial-help requests can be coordinated without Agape holding funds.

**Core workflow**

Request → discover → volunteer → coordinate → fulfill → confirm.

Implement:

- Request creation with category, short description, approximate location, timing, and relevant practical details.
- Nearby discovery with list-first browsing and optional map.
- Volunteer profiles, availability, service radius, and clearly labeled self-reported skills.
- Claiming, private coordination, cancellation, reopening, completion, and reporting.
- Notifications with explicit delivery limitations and recovery from failed sends.
- A moderation interface with reports, suspensions, abuse controls, and audit history.

Use real persistence and authorization. Claims must be atomic so concurrent volunteers do not accidentally overwrite each other. Support multiple helper roles where appropriate.

**Emergency assistance is a required feature**

Include distinct actions for:

1. **Ask someone to call 911 for me**, including when the requester’s battery is nearly dead or they cannot make the call themselves.
2. **Request nearby CPR assistance.**
3. **Ask someone to bring an AED.**

These supplement emergency services. They are not an emergency dispatch service, a monitored emergency line, or a guarantee that someone will respond.

Keep a prominent direct emergency-call action visible. Clearly tell users to contact emergency services immediately if able and not wait for a volunteer. Do not imply that using Agape saves more battery than calling directly.

For the initial US emergency experience:

- Require as few steps as possible. Do not put account creation, email verification, tutorials, or payment screens before emergency actions.
- Capture the incident location, including manual address or landmark entry, essential incident details, and an optional callback number.
- Request geolocation only with consent. Display its timestamp and accuracy when available; let users correct it. Never equate the helper’s location with the incident location.
- Use a lightweight screen suitable for weak connections and low battery. Avoid continuous GPS, animations, mandatory maps, and repeated polling.
- Distinguish clearly between unsent, server-received, helper-accepted, and helper-reported emergency-service contact. Offline or failed requests must never appear delivered.
- Keep the emergency request accessible through a secure recovery link or token without exposing it publicly.

A volunteer accepting a call-backup task is NOT proof that 911 was contacted.

Track these milestones separately, with timestamps and attribution:

- Request received by Agape.
- Volunteer accepted the call task.
- Volunteer reports contacting emergency services.
- Volunteer reports relaying the incident location and details.
- Any dispatcher instructions relayed by that volunteer.

Use wording such as “Volunteer reports contacting 911,” not “Ambulance dispatched” or “Help is on the way.” Record dispatch information only if explicitly reported, and label its source.

A remote helper’s emergency call may reach a different jurisdiction. Address that explicitly in the caller workflow: state immediately that the emergency is at another location and give the exact incident address. Research authoritative guidance before implementing jurisdiction-specific instructions; do not promise automatic routing or transfer.

If a volunteer abandons a task or fails to confirm contact, surface the lack of confirmation and make reassignment possible. Never silently close an emergency as resolved because a timer expired or the requester disconnected.

CPR assistance, AED retrieval, and the emergency-call task must be independently claimable. Claiming one must not suppress the others.

**Medical content and emergency limitations**

Use current, authoritative sources such as 911.gov, the American Heart Association, and the American Red Cross. Record source links and review dates.

Do not generate improvised medical instructions or use an AI chatbot to decide whether someone deserves emergency help. Follow dispatcher guidance and authoritative first-aid resources. Do not present adult-only CPR guidance as universally applicable to children, infants, or all incident types.

Label claimed training as self-reported unless actually verified. Do not imply that an AED location, volunteer qualification, or responder availability has been verified when it has not.

Do not hardcode 911 globally. Clearly label initial emergency coverage as US-specific and make the architecture ready for verified country-specific emergency information. Do not silently infer the correct emergency number solely from browser language.

**Privacy, trust, and abuse prevention**

Show approximate locations in public discovery. Restrict exact addresses, callback numbers, sensitive circumstances, and emergency details to appropriately authorized participants. Make emergency location sharing explicit and purpose-limited.

Prevent anonymous scraping of people in distress. Include reporting, blocking, rate limits, secure guest tokens, access controls, and protection against fraudulent requests, harassment, and malicious emergency reporting.

Use proportional verification without delaying access to the direct emergency-call action. Keep sensitive details out of analytics, URLs, public search indexing, and notification previews. Establish short, documented retention rules for precise location and sensitive incident data.

Start with adult accounts; do not build unsupervised matching between children and strangers.

**Design and engineering**

Create a calm, dignified, accessible, mobile-first interface. The main choices should be obvious:

- I need help.
- I can help.
- Emergency assistance.

Use plain language, large touch targets, strong contrast, keyboard accessibility, and screen-reader-friendly status updates. Explain low volunteer coverage honestly.

Prefer a simple maintainable architecture over unnecessary services. Use appropriate database constraints, authorization, notification retries, and operational monitoring. Do not fabricate testimonials, activity, helpers, emergency coverage, or successful rescues.

**Validation and launch**

Test the complete ordinary-help workflow and the emergency edge cases:

- Simultaneous claims.
- Denied or inaccurate geolocation.
- Nearly dead battery and requester disconnection.
- Lost connectivity before and after submission.
- Notification failure.
- Volunteer cancellation or disappearance.
- A remote caller in another jurisdiction.
- Multiple emergency roles on one incident.
- Unauthorized access to sensitive details.
- Duplicate requests and abusive submissions.

Use simulated emergency scenarios only. Never place real emergency calls or alert real volunteers as part of testing.

Deploy with HTTPS at **agape.openmissionofhope.org**, verify the live application, and document required environment variables, database migrations, DNS changes, and operational procedures.

Implement and test emergency features fully, but do not expose them as operational if delivery, staffing expectations, or other dependencies are unconfigured. Show their actual availability plainly.

Deliver the working application, relevant tests, a concise architecture and operations README, and an honest report of what is live, what was verified, and any remaining blockers.
