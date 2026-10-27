# Emergency assistance: design, sources and limits

Agape supplements emergency services for three bystander tasks:

1. **Ask someone to call 911 for me** — when the requester cannot call (dying battery, no voice, panic, no service).
2. **Request nearby CPR assistance.**
3. **Ask someone to bring an AED.**

Agape is **not** an emergency service, dispatch center or monitored line, does not contact 911
itself, and cannot guarantee anyone responds. Every emergency page keeps a direct `tel:911`
action visible and tells people to call first if they can.

## Flow

* No account, email, tutorial or payment before the form. One page: needs (checkboxes), where
  (typed address/landmark, optional ZIP, optional one-time device location with consent),
  what is happening, optional details and callback number.
* Device location is read once (`getCurrentPosition`, no `watchPosition`), shown with its
  accuracy and time, and removable. Readings over 500 m accuracy are flagged as imprecise. If the
  requester says the emergency is "somewhere else", device coordinates are discarded. A
  volunteer's location is never used as the incident location.
* The page is ~4 KB of HTML plus two small scripts; no map, fonts, animation or polling.
  The status page refreshes only when the person presses "Refresh status".
* Send states are explicit. Without JavaScript, the browser either shows the server's status page
  (received) or its own error. With JavaScript: "Sending… not received yet", "NOT SENT — offline",
  "NOT CONFIRMED — connection failed" (retry is safe: the one-time key returns the same request),
  or the server's reason. A request is shown as received only after the server confirms it.
* The requester keeps access through an HttpOnly cookie scoped to the request path and a private
  link (`/r/<token>`) they can copy or share with someone they trust.

## Milestones (tracked separately, timestamped and attributed)

| Event | Wording shown |
|---|---|
| `received` | "Received by Agape" |
| `role_accepted` | "Accepted by *name*" + "Accepting the task is not confirmation that 911 was called." |
| `ems_contacted` | "Volunteer reports contacting 911 — reported by *name*" |
| `location_relayed` | "Volunteer reports giving the incident location and details to the dispatcher" |
| `dispatcher_instructions` | "Dispatcher instructions relayed by the volunteer: …" |
| `dispatch_info` | "Volunteer reports what the dispatcher said about a response: …" + "(as reported by the volunteer; not confirmed by Agape or 911)" |
| `requester_ems_contacted` | "The requester reports that 911 has been called." |

Agape never says "help is on the way" or "ambulance dispatched". The tests assert this.

## Abandonment and reassignment

* Unconfirmed call task (no `ems_contacted` 3 minutes after acceptance) or CPR/AED task (no "on my
  way"/"arrived" after 10 minutes): shown to the requester as **Not confirmed** with "If you can,
  call 911 yourself"; recorded once on the timeline; other eligible volunteers are re-alerted; any
  of them can take over (the old claim becomes `lapsed`, and its holder is told).
* The requester can ask for another volunteer at any time.
* A volunteer can release a task (or report "could not get an AED"); it reopens and others are alerted.
* Emergencies are never closed by a timer or by the requester disappearing. After 2 hours without
  activity by a person they are listed as **stale** for moderators, who may close them with an
  explicit reason (for example "requester unreachable for 6 hours; outcome unknown").

## Remote callers and jurisdiction

A volunteer calling 911 reaches the 911 center for *their own* location. The call-task page always
shows this guidance (and highlights it when the volunteer's service area is more than 15 km from
the incident), with the exact incident address embedded in a script:

* "Calling 911 connects you to the 911 center for where you are, not where the emergency is. With
  few exceptions, 911 calls cannot be transferred to other towns, cities or states."
* "If the emergency is in a different city, county or state from you, the best option is to call
  the 10-digit emergency number for law enforcement in the community where help is needed. Those
  numbers are on the local law-enforcement agency's website."
* "Whoever you reach, say at once that the emergency is at another location, then give the exact
  address, including the city and state."
* "Agape cannot route, connect or transfer your call."

Source: 911.gov FAQ, "How can I reach 911 in a different state, county or city?" (reviewed
2026-10-26 from the Internet Archive copy of 2026-09-18, page last updated 03/08/2023). The same FAQ
notes that apps must have the technical ability and legal authority to contact 911 on a caller's
behalf — one reason Agape never contacts 911 itself.

## Medical content

Agape writes no medical instructions of its own and uses no AI to decide who gets help. It shows a
few attributed statements with their scope and links to the full guidance:

| Statement | Source |
|---|---|
| Follow the dispatcher; many 911 centers give step-by-step CPR instructions | 911.gov, Calling 911 |
| AHA recommends Hands-Only CPR for bystanders who see a teen or adult suddenly collapse outside a hospital | AHA, What is CPR? |
| AHA still recommends compressions *and breaths* for infants and children and for drowning, drug overdose, or collapse due to breathing problems | AHA, CPR Fact Sheet (2025) |
| As soon as an AED is available, turn it on and follow its voice prompts | Red Cross, AED Steps |
| Red Cross AED steps are written for adults and children 8+ weighing over 55 lb | Red Cross, AED Steps |

All sources, with review dates and notes, are in `src/content/emergency.ts` and on
`/emergency/guidance`. 911.gov, heart.org, redcross.org and fcc.gov refuse automated requests, so
they were reviewed through Internet Archive copies from August–October 2026; a person should
re-check the live pages. **Review every source at least every six months.**

Agape has not verified any AED location, responder qualification or availability. Skills are
labelled self-reported unless a moderator records what they checked.

## Availability gate

`AGAPE_EMERGENCY_MODE=off` (default): the emergency pages, direct call, location helper ("find my
location to tell the dispatcher", nothing sent) and guidance work; submissions are refused with a
plain explanation. `pilot`: submissions open with a permanent "Pilot service — no guarantee anyone
will respond" notice and live reasons (no automatic alerts configured, no registered emergency
volunteers). Moderators can pause submissions instantly from `/mod` without a deploy.

See [OPERATIONS.md](OPERATIONS.md#turning-on-emergency-requests) for the checklist before switching to `pilot`.
