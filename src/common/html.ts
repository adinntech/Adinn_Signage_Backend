/**
 * Rich text from the CRM editors (email bodies, quotation terms). Keeps only simple formatting tags and drops every
 * attribute, so stored HTML can be rendered in the web app and sent by email without carrying scripts, styles or links
 * that the user did not type as text.
 */
const ALLOWED = new Set(['b', 'strong', 'i', 'em', 'u', 'p', 'br', 'ul', 'ol', 'li', 'div', 'span', 'h3', 'h4']);
/** Any "<" that is not one of the clean tags written above is text. */
const STRAY_LT = new RegExp(`<(?!/?(?:${[...ALLOWED].join('|')})>)`, 'gi');

export function sanitizeHtml(input: string): string {
  return String(input ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|iframe|object|embed|template|svg|math)[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\/?([a-zA-Z0-9]+)\b[^>]*>/g, (tag, name: string) => {
      const n = name.toLowerCase();
      if (!ALLOWED.has(n)) return '';
      if (tag.startsWith('</')) return n === 'br' ? '' : `</${n}>`;
      return n === 'br' ? '<br>' : `<${n}>`;
    })
    .replace(STRAY_LT, '&lt;')
    .trim();
}

/** Plain-text version of sanitized HTML (email text part, change history, PDF). */
export function htmlToText(html: string): string {
  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li>/gi, '\n• ')
    .replace(/<\/(p|div|h3|h4|ul|ol)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Escape plain text for HTML. */
export const escapeHtml = (s: string) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
