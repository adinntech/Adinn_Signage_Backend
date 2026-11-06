<?php require_once __DIR__.'/_common.php';
/* Forgot MPIN / forgot password mail. One template, wording switches on $data['mailtype'] (forgot_mpin | forgot_password). */
$isMpin=($data['mailtype']??'')==='forgot_mpin';
$what=$isMpin?'MPIN':'password';
$name=trim((string)($data['userName']??''))?:'there';
$code=preg_replace('/\D/','',(string)($data['code']??''));
$mins=max(1,(int)($data['expiresInMinutes']??10));

pageStart('Reset your '.$what,'We received a request to reset the '.$what.' of your Signage account.',$config);

echo '<p style="font-size:13px;line-height:1.7;color:#394d6b;margin:0 0 14px">Hi <strong>'.esc($name).'</strong>, use the verification code below in the Signage app to set a new '.esc($what).'.</p>';

/* The code is digits only, letter-spaced, so it is easy to read and copy. */
echo '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 14px"><tr><td align="center" style="background:#f4f8fd;border:1px dashed #9fb3d9;border-radius:10px;padding:18px 10px">';
echo '<div style="font-size:11px;color:#6a7890;margin-bottom:6px;letter-spacing:1px">VERIFICATION CODE</div>';
/* Email clients cannot run a copy button (no scripts). user-select:all makes one click / long-press select the whole code, then Copy. */
/* One white box per digit (table cells, so it holds in Outlook too). The cells sit inside one user-select:all span, so a click still selects the whole code. */
$cells='';
foreach(str_split($code) as $d)$cells.='<td align="center" width="38" style="width:38px;height:48px;background:#ffffff;border:1px solid #d6e4fa;border-radius:8px;font-family:Consolas,\'Courier New\',monospace;font-size:28px;font-weight:600;color:#10244a;-webkit-user-select:all;user-select:all;cursor:copy">'.esc($d).'</td><td width="6" style="width:6px;font-size:0">&nbsp;</td>';
/* No redirect: the code itself is the copy target. One click copies it where the mail client runs inline script (rare: Gmail, Outlook and Apple Mail strip it); everywhere else one click / long-press selects the whole code (user-select:all), then Copy. */
$onclick="try{navigator.clipboard.writeText('".$code."');var h=this.parentNode.querySelector('.hint');if(h){h.innerHTML='Copied! &#10003;';h.style.color='#059669';}}catch(e){}";
echo '<table role="presentation" align="center" cellpadding="0" cellspacing="0" title="Click to copy" onclick="'.esc($onclick).'" style="margin:0 auto;cursor:copy"><tr>'.$cells.'</tr></table>';
echo '<div class="hint" style="font-size:11px;color:#6a7890;margin-top:10px">Click the code to select it, then copy</div>';
/* Fallback for clients that strip script (Gmail, Outlook, Apple Mail): opens copy.html, which copies the code from the #fragment (never sent to a server) and closes itself. */
$copyUrl=rtrim((string)($config['copy_url']??''),'#').'#'.$code;
echo '<div style="margin-top:10px"><a href="'.esc($copyUrl).'" target="_blank" rel="noopener" style="display:inline-block;background-color:#7c3aed;background-image:linear-gradient(90deg,#7c3aed,#f26b3a);color:#ffffff;font-size:12px;font-weight:600;text-decoration:none;border-radius:8px;padding:8px 18px">Copy code &nbsp;&#128203;</a></div>';
echo '<div style="font-size:11px;color:#6a7890;margin-top:4px">Valid for '.esc((string)$mins).' minutes &middot; can be used once</div>';
echo '</td></tr></table>';

echo card('How to reset',
 '<ol style="margin:6px 0 4px 18px;padding:0;font-size:12px;line-height:1.9;color:#394d6b"><li>Open the Signage app and tap <strong>Forgot '.esc($what).'</strong>.</li><li>Enter your email and this code.</li><li>Choose your new '.($isMpin?'4-digit MPIN':'password').' (you can switch to '.($isMpin?'a password':'a 4-digit MPIN').' there if you prefer) and sign in.</li></ol>',
 '#eaf2ff','#1d4ed8','#d6e4fa');

noteBar('If you did not ask for this, ignore this email. Your current '.$what.' stays the same. Never share this code with anyone, including the Adinn team.');
if(!empty($data['requestId']))echo '<p style="font-size:10px;color:#8a96ab;margin:0 0 8px">Reference: '.esc($data['requestId']).'</p>';
pageEnd('Regards,','Adinn Signage Support',$config);
