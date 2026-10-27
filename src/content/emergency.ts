// Emergency content. Every instruction here is attributed to an authoritative
// source with the date it was last reviewed. Do not add improvised medical
// instructions: link to the source, or tell people to follow the dispatcher.
// Review all sources at least every 6 months (docs/OPERATIONS.md).

export interface Source {
  id: string;
  title: string;
  publisher: string;
  url: string;
  reviewedAt: string;
  note?: string;
}

export const SOURCES: Record<string, Source> = {
  calling911: {
    id: 'calling911',
    title: 'Calling 911',
    publisher: 'National 911 Program (911.gov, NHTSA)',
    url: 'https://www.911.gov/calling-911/',
    reviewedAt: '2026-10-26',
    note: 'Page last updated 01/24/2023. Reviewed from the Internet Archive copy of 2026-09-07 because 911.gov refuses automated requests.',
  },
  faq911: {
    id: 'faq911',
    title: 'Calling 911: Frequently Asked Questions',
    publisher: 'National 911 Program (911.gov, NHTSA)',
    url: 'https://www.911.gov/calling-911/frequently-asked-questions/',
    reviewedAt: '2026-10-26',
    note: 'Page last updated 03/08/2023. Reviewed from the Internet Archive copy of 2026-09-18 because 911.gov refuses automated requests.',
  },
  text911: {
    id: 'text911',
    title: 'Text to 911: What You Need to Know',
    publisher: 'Federal Communications Commission',
    url: 'https://www.fcc.gov/consumers/guides/what-you-need-know-about-text-911',
    reviewedAt: '2026-10-26',
    note: 'Reviewed from the Internet Archive copy of 2026-09-23 because fcc.gov refuses automated requests.',
  },
  ahaHandsOnly: {
    id: 'ahaHandsOnly',
    title: 'Hands-Only CPR (videos in English, Spanish and Mandarin)',
    publisher: 'American Heart Association',
    url: 'https://cpr.heart.org/en/cpr-courses-and-kits/hands-only-cpr',
    reviewedAt: '2026-10-26',
    note: 'Reviewed from the Internet Archive copy of 2026-10-12 because heart.org refuses automated requests.',
  },
  ahaWhatIsCpr: {
    id: 'ahaWhatIsCpr',
    title: 'What is CPR?',
    publisher: 'American Heart Association',
    url: 'https://cpr.heart.org/en/resources/what-is-cpr',
    reviewedAt: '2026-10-26',
    note: 'Reviewed from the Internet Archive copy of 2026-10-08.',
  },
  ahaFactSheet: {
    id: 'ahaFactSheet',
    title: 'CPR Fact Sheet (2025)',
    publisher: 'American Heart Association',
    url: 'https://www.heart.org/en/-/media/Files/Nation-of-Lifesavers/2025-CPR-Fact-Sheet.pdf',
    reviewedAt: '2026-10-26',
    note: 'Reviewed from the Internet Archive copy of 2026-08-04.',
  },
  redCrossCpr: {
    id: 'redCrossCpr',
    title: 'CPR Steps',
    publisher: 'American Red Cross',
    url: 'https://www.redcross.org/take-a-class/cpr/performing-cpr/cpr-steps',
    reviewedAt: '2026-10-26',
    note: 'Reviewed from the Internet Archive copy of 2026-10-06.',
  },
  redCrossChildCpr: {
    id: 'redCrossChildCpr',
    title: 'Child & Baby CPR Steps',
    publisher: 'American Red Cross',
    url: 'https://www.redcross.org/take-a-class/cpr/performing-cpr/child-baby-cpr',
    reviewedAt: '2026-10-26',
    note: 'Reviewed from the Internet Archive copy of 2026-10-15.',
  },
  redCrossAed: {
    id: 'redCrossAed',
    title: 'AED Steps',
    publisher: 'American Red Cross',
    url: 'https://www.redcross.org/take-a-class/aed/using-an-aed/aed-steps',
    reviewedAt: '2026-10-26',
    note: 'Reviewed from the Internet Archive copy of 2026-10-12.',
  },
};

/**
 * Country-specific emergency information. Only entries with status 'verified'
 * are used to show an emergency number. The country is chosen by the person
 * (default: United States, the only coverage today) and never inferred from
 * browser language.
 */
export interface Jurisdiction {
  code: string;
  name: string;
  status: 'verified' | 'unverified';
  emergencyNumber: string;
  dialHref: string;
  callFirst: string;
  textGuidance: string;
  remoteCaller: string[];
  dispatcherAsks: string[];
  sources: string[];
}

export const JURISDICTIONS: Record<string, Jurisdiction> = {
  US: {
    code: 'US',
    name: 'United States',
    status: 'verified',
    emergencyNumber: '911',
    dialHref: 'tel:911',
    callFirst: 'If you can make a call, call 911 now. Do not wait for a volunteer.',
    textGuidance: 'Call if you can, text if you can’t. Text to 911 works only in some areas; if it is not available you should get an immediate bounce-back message.',
    remoteCaller: [
      'Calling 911 connects you to the 911 center for where you are, not where the emergency is. With few exceptions, 911 calls cannot be transferred to other towns, cities or states.',
      'If the emergency is in a different city, county or state from you, the best option is to call the 10-digit emergency number for law enforcement in the community where help is needed. Those numbers are on the local law-enforcement agency’s website.',
      'Whoever you reach, say at once that the emergency is at another location, then give the exact address, including the city and state.',
      'Agape cannot route, connect or transfer your call.',
    ],
    dispatcherAsks: [
      'The location of the emergency, including the street address and apartment or room number',
      'The phone number you are calling from',
      'What is happening',
      'Details, such as injuries or symptoms',
    ],
    sources: ['calling911', 'faq911', 'text911'],
  },
};

export const DEFAULT_JURISDICTION = 'US';

export const EMERGENCY_ROLES = {
  call_911: {
    key: 'call_911',
    need: 'Ask someone to call 911 for me',
    short: 'Call 911',
    volunteerTask: 'Call emergency services for this person and report back',
    slots: 1,
  },
  cpr: {
    key: 'cpr',
    need: 'Request nearby CPR assistance',
    short: 'CPR',
    volunteerTask: 'Go to the location to help with CPR',
    slots: 2,
  },
  aed: {
    key: 'aed',
    need: 'Ask someone to bring an AED',
    short: 'AED',
    volunteerTask: 'Bring an AED (automated external defibrillator) to the location',
    slots: 1,
  },
} as const;

export type EmergencyRole = keyof typeof EMERGENCY_ROLES;
export const EMERGENCY_ROLE_KEYS = Object.keys(EMERGENCY_ROLES) as EmergencyRole[];

export const INCIDENT_TYPES = [
  { key: 'collapsed', label: 'Someone collapsed or is unresponsive' },
  { key: 'not_breathing', label: 'Someone is not breathing normally' },
  { key: 'medical', label: 'Other medical emergency' },
  { key: 'injury', label: 'Injury or crash' },
  { key: 'fire', label: 'Fire or smoke' },
  { key: 'danger', label: 'Crime or danger to someone' },
  { key: 'other', label: 'Something else' },
] as const;

export const INCIDENT_LABEL = new Map<string, string>(INCIDENT_TYPES.map((t) => [t.key, t.label]));

/** Attributed points shown to CPR and AED volunteers, with their scope. Links carry the full instructions. */
export const RESPONDER_GUIDANCE = {
  cpr: [
    { text: 'Follow the 911 dispatcher’s instructions. Many 911 centers can give step-by-step CPR instructions over the phone.', source: 'calling911' },
    { text: 'The American Heart Association recommends Hands-Only CPR (no breaths) for bystanders who see a teen or adult suddenly collapse outside a hospital.', source: 'ahaWhatIsCpr' },
    { text: 'The AHA still recommends CPR with compressions and breaths for infants and children, and for victims of drowning, drug overdose, or people who collapse due to breathing problems. Hands-Only CPR is not the guidance for them; follow the dispatcher.', source: 'ahaFactSheet' },
  ],
  aed: [
    { text: 'As soon as an AED is available, turn it on and follow its voice prompts.', source: 'redCrossAed' },
    { text: 'The Red Cross AED steps are written for adults and for children aged 8 or older who weigh more than 55 pounds. For younger or smaller children, follow the dispatcher and the device’s instructions.', source: 'redCrossAed' },
  ],
} as const;

export const NOT_A_SERVICE = 'Agape is not an emergency service, not a dispatch center and not a monitored emergency line. Volunteers may not respond, and Agape itself never contacts 911.';
