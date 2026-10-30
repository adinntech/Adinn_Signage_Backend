<?php
function esc($v):string{return htmlspecialchars(is_scalar($v)?(string)$v:'',ENT_QUOTES|ENT_SUBSTITUTE,'UTF-8');}
function section(string $title,array $rows,string $accent='#0b6bcf'):void{
 echo '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e3eaf4;border-radius:9px;margin:0 0 14px;background:#fff"><tr><td style="padding:13px 16px;background:#f2f7ff;color:'.esc($accent).';font-size:16px;font-weight:bold">'.esc($title).'</td></tr><tr><td style="padding:8px 16px">';
 foreach($rows as $key=>$value){if($value===null||$value==='')continue;echo '<table role="presentation" width="100%" style="border-bottom:1px solid #eef1f5" cellpadding="0" cellspacing="0"><tr><td valign="top" width="38%" style="padding:9px 4px;color:#6a7890;font-size:12px">'.esc($key).'</td><td valign="top" style="padding:9px 4px;color:#152d56;font-size:12px;font-weight:600;word-break:break-word">'.nl2br(esc($value)).'</td></tr></table>';}
 echo '</td></tr></table>';
}
function headerMail(string $title,array $data,array $config):void{
 echo '<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#edf2f8;font-family:Arial,Helvetica,sans-serif;color:#14294d"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#edf2f8"><tr><td align="center" style="padding:24px 10px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#fff;border:1px solid #e3eaf4;border-radius:12px"><tr><td style="padding:25px 26px 15px;border-top:4px solid #ed2435"><img src="'.esc($config['logo_url']).'" alt="Adinn" width="116" style="max-width:116px;height:auto;border:0"><div style="font-size:11px;color:#64748b;margin-top:12px;letter-spacing:1px">SIGNAGE SOLUTIONS · INTERNAL REQUEST</div><h1 style="font-size:25px;line-height:1.25;color:#10244a;margin:10px 0">'.esc($title).'</h1><p style="font-size:13px;line-height:1.7;color:#61718a">Please review the details and supporting documents below and create the requested code.</p></td></tr><tr><td style="padding:0 26px 22px">';
 section('Request Information',['Request ID'=>$data['requestId']??'','Request Date'=>$data['requestDate']??date('d M Y'),'Request Source'=>$data['source']??'Client Servicing Team']);
}
function attachmentsMail(array $data):void{
 $items=$data['attachments']??[];if(!$items)return;
 echo '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e3eaf4;border-radius:9px;margin-bottom:15px"><tr><td style="padding:12px 16px;background:#eef9f2;color:#157346;font-size:15px;font-weight:bold">Attachments</td></tr><tr><td style="padding:10px 16px">';
 foreach($items as $a){echo '<div style="padding:9px 0;border-bottom:1px solid #edf1f6;color:#243c63;font-size:12px">&#128206; '.esc($a['filename']??'Document').'</div>';}
 echo '</td></tr></table>';
}
function footerMail(array $data):void{
 echo '<div style="padding:13px 15px;background:#eaf5ff;color:#215b99;border-radius:7px;font-size:12px;line-height:1.6">The confirmed code(s) will be used in the Create Project and subsequent signage workflows. Please notify the Client Servicing Team once processed.</div>';
 if(!empty($data['message']))echo '<p style="font-size:12px;line-height:1.7;color:#394d6b"><strong>Additional Notes:</strong> '.nl2br(esc($data['message'])).'</p>';
 echo '<p style="font-size:12px;line-height:1.7;color:#5b6c83;margin-top:22px">Regards,<br><strong>Client Servicing Team</strong><br>Adinn Advertising Services Ltd.</p></td></tr><tr><td style="border-top:1px solid #e7edf4;padding:16px 26px;color:#7b8798;font-size:11px">Adinn Advertising Services Ltd. &nbsp; | &nbsp; Signage Solutions</td></tr></table></td></tr></table></body></html>';
}
