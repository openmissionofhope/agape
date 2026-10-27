export interface PracticalField {
  key: string;
  label: string;
  hint?: string;
  type: 'text' | 'number' | 'yesno';
  max?: number;
}

export interface Category {
  key: string;
  label: string;
  description: string;
  roles: { key: string; label: string }[];
  fields: PracticalField[];
  caution?: string;
}

const helper = { key: 'helper', label: 'Helper' };

export const CATEGORIES: Category[] = [
  {
    key: 'food',
    label: 'A meal or food',
    description: 'Something to eat today, or help getting food.',
    roles: [helper],
    fields: [
      { key: 'people', label: 'How many people?', type: 'number', max: 20 },
      { key: 'dietary', label: 'Allergies or dietary needs', type: 'text', max: 200 },
    ],
  },
  {
    key: 'groceries',
    label: 'Groceries',
    description: 'Picking up or donating groceries.',
    roles: [helper],
    fields: [
      { key: 'items', label: 'What is needed?', type: 'text', max: 300 },
      { key: 'can_meet', label: 'Can you meet the helper at the door?', type: 'yesno' },
    ],
  },
  {
    key: 'shelter',
    label: 'Temporary shelter',
    description: 'A safe place to stay for a short time, or help finding one.',
    roles: [helper],
    fields: [
      { key: 'people', label: 'How many people?', type: 'number', max: 20 },
      { key: 'nights', label: 'For how many nights?', type: 'number', max: 30 },
      { key: 'pets', label: 'Pets or service animals?', type: 'text', max: 100 },
    ],
    caution: 'For your safety, meet first in a public place, tell someone you trust where you are going, and leave if you feel unsafe. Local shelters and 211 can also help.',
  },
  {
    key: 'transportation',
    label: 'A ride',
    description: 'Getting to work, an appointment, a store or home.',
    roles: [{ key: 'driver', label: 'Driver' }],
    fields: [
      { key: 'from_area', label: 'Pick-up area', hint: 'Neighborhood or landmark; share the exact address privately with your helper', type: 'text', max: 120 },
      { key: 'to_area', label: 'Destination area', type: 'text', max: 120 },
      { key: 'passengers', label: 'Passengers', type: 'number', max: 8 },
      { key: 'mobility', label: 'Wheelchair, car seat or other needs', type: 'text', max: 200 },
    ],
  },
  {
    key: 'roadside',
    label: 'Roadside assistance',
    description: 'A jump start, a flat tire, fuel, or a push.',
    roles: [helper],
    fields: [
      { key: 'vehicle', label: 'Vehicle', hint: 'Make, model and color', type: 'text', max: 100 },
      { key: 'problem', label: 'What is wrong?', type: 'text', max: 200 },
      { key: 'safe_location', label: 'Are you somewhere safe, off the road?', type: 'yesno' },
    ],
    caution: 'If you are in a dangerous spot on a highway or anyone is hurt, call 911.',
  },
  {
    key: 'practical',
    label: 'Practical help',
    description: 'Moving something, a small repair, yard work, paperwork, or a hand.',
    roles: [helper],
    fields: [
      { key: 'task', label: 'What needs doing?', type: 'text', max: 300 },
      { key: 'duration', label: 'About how long will it take?', type: 'text', max: 60 },
      { key: 'tools', label: 'Tools or vehicle needed', type: 'text', max: 120 },
    ],
  },
  {
    key: 'items',
    label: 'Donated items',
    description: 'Clothing, a coat, a phone charger, baby supplies, furniture.',
    roles: [helper],
    fields: [
      { key: 'items', label: 'What item?', type: 'text', max: 200 },
      { key: 'size', label: 'Size or quantity', type: 'text', max: 60 },
    ],
  },
  {
    key: 'financial',
    label: 'Financial help',
    description: 'A bill, a prescription, a bus pass. Agape never holds or moves money.',
    roles: [helper],
    fields: [
      { key: 'purpose', label: 'What is it for?', type: 'text', max: 200 },
      { key: 'amount', label: 'Approximate amount (USD)', type: 'number', max: 100000 },
      { key: 'pay_direct', label: 'Can a helper pay the business directly (for example a utility or pharmacy)?', type: 'yesno' },
    ],
    caution: 'Agape does not hold, transfer or guarantee money. Paying a business directly is safest. Never share bank passwords or one-time codes, and never send money to someone who pressures you.',
  },
  {
    key: 'other',
    label: 'Something else',
    description: 'Any other practical, lawful need.',
    roles: [helper],
    fields: [],
  },
];

export const CATEGORY_BY_KEY = new Map(CATEGORIES.map((c) => [c.key, c]));

export const TIMING_OPTIONS = [
  { key: 'asap', label: 'As soon as possible' },
  { key: 'today', label: 'Today' },
  { key: 'this_week', label: 'This week' },
  { key: 'flexible', label: 'Flexible' },
] as const;

export const TIMING_LABEL = new Map<string, string>(TIMING_OPTIONS.map((t) => [t.key, t.label]));

export const SKILLS = [
  { key: 'cpr', label: 'CPR training' },
  { key: 'first_aid', label: 'First-aid training' },
  { key: 'aed_access', label: 'Can bring an AED' },
  { key: 'vehicle', label: 'Has a car' },
  { key: 'truck', label: 'Has a truck or van' },
  { key: 'jump_start', label: 'Jump-start cables or battery pack' },
  { key: 'lifting', label: 'Can lift heavy items' },
  { key: 'repairs', label: 'Basic repairs' },
  { key: 'cooking', label: 'Cooking' },
  { key: 'spanish', label: 'Speaks Spanish' },
  { key: 'asl', label: 'Uses American Sign Language' },
  { key: 'other_language', label: 'Speaks another language' },
] as const;

export const SKILL_LABEL = new Map<string, string>(SKILLS.map((s) => [s.key, s.label]));
