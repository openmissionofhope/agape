/** Escaped-by-default HTML templating. Interpolated values are escaped unless they are SafeHtml. */
export class SafeHtml {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

type Value = SafeHtml | string | number | boolean | null | undefined | Value[];

function render(v: Value): string {
  if (v === null || v === undefined || v === false || v === true) return '';
  if (v instanceof SafeHtml) return v.value;
  if (Array.isArray(v)) return v.map(render).join('');
  return escapeHtml(String(v));
}

export function html(strings: TemplateStringsArray, ...values: Value[]): SafeHtml {
  let out = strings[0] ?? '';
  for (let i = 0; i < values.length; i++) out += render(values[i] as Value) + (strings[i + 1] ?? '');
  return new SafeHtml(out);
}

/** Marks trusted markup (never user input) as safe. */
export function raw(s: string): SafeHtml {
  return new SafeHtml(s);
}

export function join(items: SafeHtml[], sep = ''): SafeHtml {
  return new SafeHtml(items.map((i) => i.value).join(sep));
}
