<?php require_once __DIR__.'/_common.php';
/* Vendor amount approval request. The CRM sends only the figures (vendor.*, amounts.*); the whole mail is laid out here.
   The approver answers by replying APPROVED or NOT APPROVED; the CRM reads the reply and applies the amount. */
$v=is_array($data['vendor']??null)?$data['vendor']:[];
$a=is_array($data['amounts']??null)?$data['amounts']:[];

pageStart('Vendor Amount Approval Request','A vendor cost is above the company rate. Please reply APPROVED or NOT APPROVED.',$config);
chips($data,'Vendor Amount Approval');

echo '<p style="font-size:13px;line-height:1.7;color:#243857;margin:0 0 12px">Hi Team,<br>The cost below was entered for a vendor and is <strong>above the company rate</strong>. Please reply to this mail with <strong>APPROVED</strong> or <strong>NOT APPROVED</strong>.</p>';


echo card('Vendor',rowsHtml([
 ['building','Vendor',$v['vendorName']??''],
 ['key','Vendor ID',$v['vendorNo']??''],
 ['person','Entered by',$a['requestedBy']??''],
]),'#f6f0ff','#7c3aed','#e4d6fb');

/* Company rate (struck out) against what was requested, per price. Current is what the vendor has now. */
if(!function_exists("amountRow")){function amountRow(string $label,$limit,$current,$requested):string{
 $cell='padding:9px 8px;border-bottom:1px solid #edf1f7;font-size:13px;';
 return '<tr><td style="'.$cell.'font-size:12px;color:#6a7890">'.esc($label).'</td>'
  .'<td align="center" style="'.$cell.'color:#8a94a6;text-decoration:line-through">'.esc($limit).'</td>'
  .'<td align="center" style="'.$cell.'color:#10244a">'.esc($current===''||$current===null?'-':$current).'</td>'
  .'<td align="center" style="'.$cell.'font-weight:700;color:#c2410c;background:#fff4e6">'.esc($requested).'</td></tr>';
}}
$head=function(string $t,string $extra=''):string{return '<td align="center" style="padding:8px;font-size:11px;font-weight:600;letter-spacing:.3px;text-transform:uppercase;color:#6a7890;border-bottom:2px solid #fbd9b5;'.$extra.'">'.esc($t).'</td>';};
echo card('Amount per shop','<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:8px;border-bottom:2px solid #fbd9b5">&nbsp;</td>'.$head('Company rate').$head('Current').$head('Requested','color:#c2410c;background:#fff4e6;').'</tr>'
 .amountRow('Price per shop',$a['limitRate']??'',$a['currentRate']??'',$a['requestedRate']??'')
 .amountRow('Travelling cost',$a['limitFar']??'',$a['currentFar']??'',$a['requestedFar']??'')
 .'</table><p style="margin:8px 0 0;font-size:11px;color:#6a7890"><span style="text-decoration:line-through">Struck out</span> = the company rate set by Admin. <strong style="color:#c2410c">Requested</strong> is above it and needs your answer.</p>','#fff4e6','#f97316','#fbd9b5');

noteBar('Reply APPROVED to accept the requested amount. Reply NOT APPROVED (or REJECTED) and the company rate is applied instead. Please keep the Request ID in the subject.');
pageEnd('Regards,','Operations Team',$config);
