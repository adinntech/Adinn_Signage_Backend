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
echo '<div style="font-size:34px;font-weight:800;letter-spacing:10px;color:#10244a;padding-left:10px">'.esc($code).'</div>';
echo '<div style="font-size:11px;color:#6a7890;margin-top:8px">Valid for '.esc((string)$mins).' minutes &middot; can be used once</div>';
echo '</td></tr></table>';

echo card('How to reset',
 '<ol style="margin:6px 0 4px 18px;padding:0;font-size:12px;line-height:1.9;color:#394d6b"><li>Open the Signage app and tap <strong>Forgot '.esc($what).'</strong>.</li><li>Enter your email and this code.</li><li>Choose your new '.($isMpin?'4-digit MPIN':'password').' and sign in.</li></ol>',
 '#eaf2ff','#1d4ed8','#d6e4fa');

noteBar('If you did not ask for this, ignore this email. Your current '.$what.' stays the same. Never share this code with anyone, including the Adinn team.');
if(!empty($data['requestId']))echo '<p style="font-size:10px;color:#8a96ab;margin:0 0 8px">Reference: '.esc($data['requestId']).'</p>';
pageEnd('Regards,','Adinn Signage Support',$config);
