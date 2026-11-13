// Writes static HTML previews of the signage mails with sample data, so the layout can be checked in a browser without PHP.
// Run:  node src/signage_emails/signage_email_api/preview/build-previews.mjs
// This is a JS mirror of templates/_common.php + the templates; keep the two in step when the design changes.
// Banner and icons are loaded from ../templates/Images/ so the previews work offline (the real mail uses asset_url).
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = dirname(fileURLToPath(import.meta.url));
const F = "'Montserrat','Segoe UI',Arial,Helvetica,sans-serif";
const INK = '#243857', MUTED = '#6a7890', ACCENT = '#ed2435', NAVY = '#10244a';
const LOGO = 'https://adinnroadshows.com/images/logo/AdinnLogo.png';
const IMG = '../templates/Images';
const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
const ic = (k, w = 16, p = '') => `<img src="${IMG}/icons/${p}${k}.png" width="${w}" height="${w}" alt="" style="display:block;border:0;width:${w}px;height:${w}px">`;

// Document start: banner image, title, optional one-line subtitle.
const start = (title, sub = '', icon = 'note') =>
  `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600&display=swap" rel="stylesheet"><title>${esc(title)} (preview)</title></head>` +
  `<body style="margin:0;padding:0;background:#eef2f8;font-family:${F};color:${INK}"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef2f8"><tr><td align="center" style="padding:20px 8px">` +
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:700px;background:#ffffff;border:1px solid #dfe7f3;border-radius:10px;overflow:hidden">` +
  `<tr><td style="padding:0;line-height:0;font-size:0"><img src="${IMG}/Signage_Email_Header.png" alt="Adinn Signage Solutions" width="700" style="display:block;width:100%;max-width:700px;height:auto;border:0"></td></tr>` +
  `<tr><td style="background:${NAVY};padding:11px 24px;font-family:${F}"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="font-size:12px;font-weight:600;letter-spacing:.6px;color:#ffffff">&#9881;&nbsp; SYSTEM GENERATED EMAIL</td><td align="right" style="font-size:11.5px;font-weight:400;color:#d6e0f5">ADINN CRM &nbsp;|&nbsp; Operations Workflow</td></tr></table></td></tr>` +
  `<tr><td style="padding:22px 24px 6px;font-family:${F}"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px"><tr><td width="54" valign="middle"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td align="center" valign="middle" style="width:48px;height:48px;background:#fdecee;border:1px solid #f8cdd3;border-radius:11px">${ic(icon, 24)}</td></tr></table></td>` +
  `<td valign="middle" style="padding-left:14px;border-left:2px solid ${ACCENT}"><div style="font-size:21px;line-height:1.3;font-weight:600;letter-spacing:-.2px;color:${NAVY};padding-left:12px">${esc(title)}</div>` +
  (sub ? `<div style="font-size:13px;font-weight:400;line-height:1.6;color:${MUTED};padding:3px 0 0 12px">${esc(sub)}</div>` : '') + '</td></tr></table>';
const chips = (d, type) =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="6" style="margin:0 -6px 10px;width:calc(100% + 12px)"><tr>` +
  [['id', 'Request ID', d.requestId], ['date', 'Request Date', d.date], ['type', 'Request Type', type], ['source', 'Requested By', d.source]]
    .map(([i, l, v]) => `<td width="25%" valign="top" style="background:#f4f8fd;border:1px solid #e1e9f5;border-radius:8px;padding:10px"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td valign="middle" style="width:30px">${ic(i, 28, 'chip-')}</td><td valign="middle" style="padding-left:8px"><div style="font-size:10px;font-weight:400;color:${MUTED}">${esc(l)}</div><div style="font-size:12px;font-weight:500;color:${NAVY};word-break:break-word">${esc(v)}</div></td></tr></table></td>`).join('') + '</tr></table>';
const para = (h) => `<p style="font-size:13px;font-weight:400;line-height:1.7;color:${INK};margin:0 0 12px">${h}</p>`;

const ICONS = [['mobile', 'phone'], ['phone', 'phone'], ['email', 'mail'], ['gst', 'gst'], ['pan', 'pan'], ['aadhaar', 'key'], ['bank', 'folder'], ['address', 'pin'], ['location', 'pin'], ['area', 'pin'], ['date', 'date'], ['type', 'tag'], ['contact', 'person'], ['entered', 'person'], ['code', 'key'], ['order', 'folder'], ['project', 'folder'], ['scope', 'desc'], ['description', 'desc'], ['remarks', 'note']];
const rowIcon = (label) => { const l = label.toLowerCase(); const hit = ICONS.find(([k]) => l.includes(k)); if (hit) return hit[1]; if (/\bid\b/.test(l)) return 'key'; if (/client|vendor|firm|company/.test(l)) return 'building'; return 'desc'; };
const rowCell = ([i, l, v], span, pct, divider) => `<td colspan="${span}" width="${pct}%" valign="top" style="padding:10px;border-bottom:1px solid #edf1f7;${divider ? 'border-left:1px solid #edf1f7;' : ''}"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td valign="top" style="width:24px;padding-top:2px">${ic(i, 16)}</td><td valign="top" style="padding-left:4px"><div style="font-size:11px;font-weight:400;color:${MUTED}">${esc(l)}</div><div style="font-size:12.5px;font-weight:500;color:${NAVY};line-height:1.5;word-break:break-word">${esc(v)}</div></td></tr></table></td>`;
// 3 per line, long values (address, scope, notes) take a full line - mirrors rowsHtml() in _common.php.
const rows = (r, cols = 3) => {
  const items = r.filter(([, v]) => String(v ?? '').trim()).map(([l, v]) => [rowIcon(l), l, String(v)]);
  const pct = Math.floor(100 / cols); let o = '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">'; let buf = [];
  const flush = () => { if (!buf.length) return; o += '<tr>' + buf.map((it, i) => rowCell(it, 1, pct, i > 0)).join(''); for (let i = buf.length; i < cols; i++) o += `<td width="${pct}%" style="border-bottom:1px solid #edf1f7;border-left:1px solid #edf1f7">&nbsp;</td>`; o += '</tr>'; buf = []; };
  for (const it of items) { if (it[2].length > 34) { flush(); o += '<tr>' + rowCell(it, cols, 100, false) + '</tr>'; } else { buf.push(it); if (buf.length === cols) flush(); } }
  flush(); return o + '</table>';
};
const THEMES = { blue: ['#eaf2ff', '#1d4ed8', '#d6e4fa'], green: ['#e9f8ef', '#16a34a', '#cfeedb'], purple: ['#f6f0ff', '#7c3aed', '#e3d5fb'], orange: ['#fff4e5', '#d97706', '#fbe3bf'], red: ['#fdecee', '#e11d48', '#f8cdd3'] };
const card = (t, body, theme = 'blue', icon = null) => { const [bg, ac, bd] = THEMES[theme]; return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${bd};border-radius:9px;overflow:hidden;margin:0 0 14px"><tr><td style="padding:11px 14px;background:${bg}"><table role="presentation" cellpadding="0" cellspacing="0"><tr>${icon ? `<td width="26" valign="middle">${ic(icon, 18)}</td>` : ''}<td valign="middle" style="color:${ac};font-size:13px;font-weight:600;letter-spacing:.2px">${esc(t)}</td></tr></table></td></tr><tr><td style="padding:2px 6px 6px;background:#ffffff">${body}</td></tr></table>`; };
const BADGE = { pdf: ['PDF', '#e11d48'], xls: ['XLS', '#16a34a'], xlsx: ['XLS', '#16a34a'], png: ['IMG', '#f59e0b'], jpg: ['IMG', '#f59e0b'] };
const files = (t, list) => card(t, `<div style="padding:8px 8px 2px">${list.map(([n, m]) => { const [tag, col] = BADGE[n.split('.').pop()] || ['FILE', '#64748b']; return `<div style="display:inline-block;vertical-align:top;width:47%;min-width:200px;margin:0 1.5% 8px 0;border:1px solid #e1e9f5;border-radius:8px;padding:8px 10px;box-sizing:border-box"><span style="display:inline-block;background:${col};color:#fff;font-size:9px;font-weight:600;border-radius:3px;padding:2px 5px;margin-right:6px">${tag}</span><span style="font-size:11px;font-weight:500;color:${NAVY}">${esc(n)}</span><div style="font-size:10px;color:${MUTED};margin-top:3px">${esc(m)}</div></div>`; }).join('')}</div>`, 'red');
const action = (t, button = '', title = 'Action Required') =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 12px;background:#eaf3ff;border:1px solid #cfe2fb;border-radius:8px"><tr><td width="28" valign="top" style="padding:13px 0 13px 14px">${ic('info', 16)}</td><td valign="middle" style="padding:11px 14px 11px 8px;font-size:12px;font-weight:400;line-height:1.6;color:#1d4f91">${title ? `<div style="font-size:13px;font-weight:600;color:#1d4f91;margin:0 0 2px">${esc(title)}</div>` : ''}${esc(t)}</td>` +
  (button ? `<td align="right" valign="middle" style="padding:0 14px 0 0"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:${NAVY};color:#ffffff;font-size:12px;font-weight:500;border-radius:6px;padding:9px 14px;white-space:nowrap">&#8617;&nbsp; ${esc(button)}</td></tr></table></td>` : '') + '</tr></table>';
const choices = (t = 'Please reply to this email with exactly one of the following:') =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 10px;background:#fdf5f6;border:1px solid #f8cdd3;border-radius:9px"><tr><td style="padding:14px 16px"><div style="font-size:12.5px;font-weight:500;color:${NAVY};margin:0 0 10px">${esc(t)}</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>` +
  `<td width="49%" align="center" style="background:#e6f7ee;border:1px solid #b6e5c9;border-radius:8px;padding:11px;font-size:14px;font-weight:600;color:#15803d">&#10004;&nbsp; APPROVED</td><td width="2%">&nbsp;</td>` +
  `<td width="49%" align="center" style="background:#fdeaec;border:1px solid #f5b8c0;border-radius:8px;padding:11px;font-size:14px;font-weight:600;color:#be123c">&#10006;&nbsp; NOT APPROVED</td></tr></table></td></tr></table>`;
const end = (g, team) =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:6px;border-top:1px solid #dfe7f3"><tr><td valign="bottom" style="font-size:12px;font-weight:400;line-height:1.7;color:#4a5b74;padding:14px 0 14px">${esc(g)}<br><strong style="font-weight:600;color:${NAVY}">${esc(team)}</strong><br>Adinn Advertising Services Ltd.</td>` +
  `<td align="right" valign="bottom" style="padding:6px 0 14px"><img src="${LOGO}" alt="Adinn" height="38" style="height:38px;width:auto;border:0;display:inline-block"><div style="font-size:12px;color:${ACCENT};font-style:italic;font-weight:500;margin-top:4px">Ideas into Visible Impact</div></td></tr></table></td></tr>` +
  `<tr><td style="padding:0;line-height:0;font-size:0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td width="70%" height="6" style="background:${NAVY};height:6px;font-size:0;line-height:0">&nbsp;</td><td width="30%" height="6" style="background:${ACCENT};height:6px;font-size:0;line-height:0">&nbsp;</td></tr></table></td></tr></table></td></tr></table></body></html>`;

const meta = (id, source = 'Operations Team') => ({ requestId: id, date: '13 Nov 2026', source });

// 1. Vendor registration
writeFileSync(join(out, 'vendor-registration.html'),
  start('Vendor Registration Request', 'Please register the following vendor in Zoho Books / ERP.', 'building') + chips(meta('Adn-Signage-VenReg-13112601'), 'Vendor Registration') +
  para('Dear Accounts Team,') +
  card('Vendor Details', rows([['Vendor / Firm', 'Sri Murugan Signs'], ['Vendor Type', 'Organization'], ['CRM Code', 'VND-0042'], ['Contact Person', 'Sathish, Manager'], ['Mobile', '8980898988'], ['Email', 'sathish@gmail.com'], ['Address', 'No.32, Pandiyan Street, Pikulam, Madurai, Tamil Nadu, 625010'], ['Service Area', 'Madurai, Theni']]), 'purple', 'person') +
  card('Tax and Bank Details', rows([['PAN', 'ABCDE1234F'], ['GST', '33ABCDE1234F1Z5'], ['Aadhaar', 'XXXX XXXX 4821'], ['Bank (Name / Account / IFSC)', 'Sri Murugan Signs / 123456789012 / SBIN0001234']]), 'blue', 'pan') +
  files('KYC Documents', [['pan.pdf', '120 KB · PAN card'], ['cancelled-cheque.png', '340 KB · Cancelled cheque']]) +
  action('Reply with the Vendor Registration ID (5 digits or more), for example "Vendor ID: 12345", once the vendor is created. Keep the Request ID in the subject.', 'Reply with Vendor ID') +
  end('Regards,', 'Operations Team'));

// 2. Vendor rate approval
const th = (t, a = 'right') => `<td align="${a}" style="padding:8px 10px;font-size:10.5px;font-weight:500;letter-spacing:.3px;text-transform:uppercase;color:${MUTED};border-bottom:2px solid #fbe3bf">${t}</td>`;
const cell = 'padding:9px 10px;border-bottom:1px solid #edf1f7;font-size:12.5px;';
const arow = (l, lim, cur, req) => `<tr><td style="${cell}color:${MUTED}">${l}</td><td align="right" style="${cell}color:#8a94a6;text-decoration:line-through">${lim}</td><td align="right" style="${cell}color:${NAVY}">${cur}</td><td align="right" style="${cell}font-weight:600;color:#c2410c;background:#fff4e6">${req}</td></tr>`;
writeFileSync(join(out, 'vendor-rate-approval.html'),
  start('Vendor Rate Approval Request', 'The rate entered for the vendor below is above the company rate set by Admin. Please review and confirm.', 'tag') + chips(meta('Adn-Signage-VenRate-13112601'), 'Rate Approval') +
  para('Dear Sir/Madam,') +
  card('Vendor Details', rows([['Vendor', 'Adn Signage'], ['Vendor ID', '13200'], ['Mobile', '8930898988'], ['Email', 'sathish@gmail.com'], ['Address', 'Madurai'], ['Entered by', 'Sathish']]), 'purple', 'building') +
  card('Rate Details', `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${th('Item', 'left')}${th('Company rate')}${th('Current')}${th('Requested')}</tr>${arow('Price per shop', '₹250', '₹240', '₹260')}${arow('Travelling cost per shop', '₹300', '-', '₹320')}</table>`, 'orange', 'tag') +
  choices() + `<p style="font-size:11px;line-height:1.6;color:${MUTED};margin:0 0 12px">APPROVED accepts the requested rate. NOT APPROVED keeps the company rate. Please keep the Request ID in the subject.</p>` +
  end('Regards,', 'Operations Team'));

// 3. Project code
writeFileSync(join(out, 'project-code.html'),
  start('Project Code Creation Request', 'This is a new client. Please create the client ID in Zoho, then the project code and estimation code for the order below.', 'folder') + chips(meta('Adn-Signage-ProCode-13112601', 'Client Servicing Team'), 'Project Code') +
  para('Dear Team,') +
  card('Client Details', rows([['Company Name', 'Devraj Reprographic Industries'], ['Client ID', '11018'], ['Email', 'sales@devrajreprographic.com'], ['GST Number', '33AADPJ7094G1ZQ'], ['Contact Person', 'Sathish, Manager'], ['Mobile', '8980898988'], ['Address', 'No.211, Anuj Kumar, Adhinath Nagar, 200 Feet Road, Madhavaram, Chennai, Tamil Nadu, 600060']]), 'blue', 'building') +
  card('Project Details', rows([['Order Number', '20261112ORD#3'], ['Assign Type', 'Only Shop Details'], ['Shops', '9 shops']]), 'green', 'folder') +
  files('Attachments (Project Requirement)', [['ADINN-QTN-20261112-3_v1_0.pdf', '46 KB'], ['20261112ORD_3_shop_list.xlsx', '8 KB']]) +
  action('') +
  end('Regards,', 'Client Servicing Team'));

// 4. Forgot password
const digits = [...'482915'].map((d) => `<td align="center" width="38" style="width:38px;height:46px;background:#ffffff;border:1px solid #d1d5db;border-radius:6px;font-family:Consolas,'Courier New',monospace;font-size:26px;color:${NAVY}">${d}</td><td width="6" style="width:6px;font-size:0">&nbsp;</td>`).join('');
writeFileSync(join(out, 'forgot.html'),
  start('Reset Your Password', '', 'key') + para('Hi Ravi Kumar,<br>Use the verification code below in the Signage app to set a new password.') +
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 14px"><tr><td align="center" style="background:#f4f8fd;border:1px solid #dbe5f4;border-radius:9px;padding:18px 10px"><div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:${MUTED};margin-bottom:10px">Verification code</div><table role="presentation" align="center" cellpadding="0" cellspacing="0" style="margin:0 auto"><tr>${digits}</tr></table><div style="margin-top:14px"><a href="../copy.html#482915" target="_blank" style="display:inline-block;background:${ACCENT};color:#ffffff;font-size:13px;font-weight:500;text-decoration:none;padding:10px 22px;border-radius:8px">Copy code</a></div><div style="font-size:12px;color:${MUTED};margin-top:10px">Valid for 10 minutes. Can be used once.</div></td></tr></table>` +
  card('How to reset', `<ol style="margin:8px 0 8px 18px;padding:0;font-size:13px;line-height:1.9;color:${INK}"><li>Open the Signage app and tap Forgot password.</li><li>Enter your email and this code.</li><li>Choose a new password and sign in.</li></ol>`, 'green') +
  action('If you did not ask for this, ignore this email; your current password stays the same. Never share this code with anyone, including the Adinn team.') +
  end('Regards,', 'Adinn Signage Support'));

console.log('Wrote vendor-registration.html, vendor-rate-approval.html, project-code.html, forgot.html in', out);
