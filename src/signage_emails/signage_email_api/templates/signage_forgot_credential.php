<?php require_once __DIR__.'/_common.php';
/* Forgot MPIN / forgot password mail. One template, wording switches on $data['mailtype'] (forgot_mpin | forgot_password). */
$isMpin=($data['mailtype']??'')==='forgot_mpin';
$what=$isMpin?'MPIN':'password';
$name=trim((string)($data['userName']??''))?:'there';
$code=preg_replace('/\D/','',(string)($data['code']??''));
$mins=max(1,(int)($data['expiresInMinutes']??10));

pageStart('Reset Your '.ucfirst($what),'',$config);

para('Hi '.esc($name).',<br>Use the verification code below in the Signage app to set a new '.esc($what).'.');

/* One box per digit (table cells, so it holds in Outlook too). user-select:all makes one click / long-press select the whole code. */
$cells='';
foreach(str_split($code) as $d)$cells.='<td align="center" width="38" style="width:38px;height:46px;background:#ffffff;border:1px solid #d1d5db;font-family:Consolas,\'Courier New\',monospace;font-size:26px;color:#111827;-webkit-user-select:all;user-select:all">'.esc($d).'</td><td width="6" style="width:6px;font-size:0">&nbsp;</td>';
echo '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px"><tr><td align="center" style="background:#f9fafb;border:1px solid '.MAIL_LINE.';padding:18px 10px">';
echo '<div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:'.MAIL_MUTED.';margin-bottom:10px">Verification code</div>';
echo '<table role="presentation" align="center" cellpadding="0" cellspacing="0" style="margin:0 auto"><tr>'.$cells.'</tr></table>';
/* No script in mail clients: the link opens copy.html, which copies the code from the #fragment (never sent to a server) and closes itself. */
$copyUrl=rtrim((string)($config['copy_url']??''),'#').'#'.$code;
echo '<div style="margin-top:14px"><a href="'.esc($copyUrl).'" target="_blank" rel="noopener" style="display:inline-block;background:'.MAIL_ACCENT.';color:#ffffff;font-size:13px;text-decoration:none;padding:9px 20px">Copy code</a></div>';
echo '<div style="font-size:12px;color:'.MAIL_MUTED.';margin-top:10px">Valid for '.esc((string)$mins).' minutes. Can be used once.</div>';
echo '</td></tr></table>';

echo card('How to reset','<ol style="margin:8px 0 0 18px;padding:0;font-size:13px;line-height:1.9;color:'.MAIL_INK.'"><li>Open the Signage app and tap Forgot '.esc($what).'.</li><li>Enter your email and this code.</li><li>Choose a new '.($isMpin?'4-digit MPIN':'password').' and sign in.</li></ol>');

noteBar('If you did not ask for this, ignore this email; your current '.$what.' stays the same. Never share this code with anyone, including the Adinn team.');
if(!empty($data['requestId']))echo '<p style="font-size:11px;color:#9ca3af;margin:0 0 12px">Reference: '.esc($data['requestId']).'</p>';
pageEnd('Regards,','Adinn Signage Support',$config);
