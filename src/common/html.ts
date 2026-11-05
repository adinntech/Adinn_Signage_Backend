/**
 * Rich text from the CRM editors (email bodies, quotation terms). Keeps only simple formatting tags and drops every
 * attribute, so stored HTML can be rendered in the web app and sent by email without carrying scripts, styles or links
 * that the user did not type as text.
 */
const ALLOWED = new Set(['b', 'strong', 'i', 'em', 'u', 'p', 'br', 'ul', 'ol', 'li', 'div', 'span', 'h2', 'h3', 'h4', 'table', 'thead', 'tbody', 'tr', 'th', 'td']);
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
    // Tables: "Label: value" rows (th then td), other cells separated by " | ", one row per line.
    .replace(/<\/th>\s*<td>/gi, ': ')
    .replace(/<\/t[hd]>\s*<t[hd]>/gi, ' | ')
    .replace(/<\/(tr|table)>/gi, '\n')
    .replace(/<\/(p|div|h2|h3|h4|ul|ol)>/gi, '\n')
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

/** Inline styles of the email layout (email clients ignore stylesheets): navy headings, subtle dividers, white card. */
const EMAIL_TAG: Record<string, string> = {
  h2: '<h2 style="margin:0 0 18px;font-family:Arial,Helvetica,sans-serif;font-size:20px;line-height:28px;font-weight:700;color:#102449">',
  h3: '<h3 style="margin:26px 0 8px;padding:0 0 6px;border-bottom:1px solid #E5E9F0;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:22px;font-weight:700;color:#102449">',
  h4: '<h4 style="margin:18px 0 6px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;font-weight:700;color:#102449">',
  p: '<p style="margin:0 0 12px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:22px;color:#1F2937">',
  table: '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;margin:0 0 6px">',
  th: '<th align="left" valign="top" style="padding:7px 16px 7px 0;border-bottom:1px solid #E5E9F0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;font-weight:600;color:#5B6B86;text-align:left;white-space:nowrap">',
  td: '<td valign="top" style="padding:7px 16px 7px 0;border-bottom:1px solid #E5E9F0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;color:#102449">',
  ul: '<ul style="margin:0 0 12px;padding:0 0 0 20px">',
  ol: '<ol style="margin:0 0 12px;padding:0 0 0 20px">',
  li: '<li style="margin:0 0 4px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:22px;color:#1F2937">',
};
/**
 * Sanitized email HTML (attribute-free tags) as an email-safe page: a centred white card built from tables, with
 * inline styles on every block, so Outlook and Gmail show it as designed. The stored body stays unstyled.
 */
export function styledEmailHtml(body: string): string {
  const inner = String(body ?? '').replace(/<(h2|h3|h4|p|table|th|td|ul|ol|li)>/g, (_, t: string) => EMAIL_TAG[t]!);
  return (
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;background:#FFFFFF">' +
    '<tr><td align="center" style="padding:24px 12px">' +
    '<table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:640px;border-collapse:separate;background:#FFFFFF;border:1px solid #E5E9F0;border-radius:8px">' +
    `<tr><td style="padding:28px 32px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:22px;color:#1F2937">${inner}</td></tr>` +
    '</table></td></tr></table>'
  );
}

/** Escape plain text for HTML. */
export const escapeHtml = (s: string) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
