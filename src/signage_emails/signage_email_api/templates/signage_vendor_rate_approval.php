<?php require_once __DIR__.'/_common.php';
/* Vendor rate approval request. The CRM sends only the figures (vendor.*, amounts.*); the whole mail is laid out here.
   The approver answers by replying APPROVED or NOT APPROVED; the CRM reads the reply and applies the amount. */
$v=is_array($data['vendor']??null)?$data['vendor']:[];
$a=is_array($data['amounts']??null)?$data['amounts']:[];

pageStart('Vendor Rate Approval Request','The rate entered for the vendor below is above the company rate set by Admin. Please review and confirm.',$config,'tag');
chips($data,'Rate Approval');

para('Dear Sir/Madam,');

echo card('Vendor Details',rowsHtml([
 ['','Vendor',$v['vendorName']??''],
 ['','Vendor ID',$v['vendorNo']??''],
 ['','Mobile',$v['mobile']??''],
 ['','Email',$v['email']??''],
 ['','Address',$v['address']??($v['city']??'')],
 ['','PAN',$v['pan']??''],
 ['','GST',$v['gstin']??''],
 ['','Entered by',$a['requestedBy']??''],
]),'#eef1fb','','#e4d6fb',null,'building');

/* Company rate (struck out) against what was requested. Current is what the vendor has now. */
if(!function_exists('amountRow')){function amountRow(string $label,$limit,$current,$requested):string{
 $cell='padding:8px 8px 8px 0;border-bottom:1px solid #f0f1f3;font-size:13px;';
 return '<tr><td style="'.$cell.'color:'.MAIL_MUTED.'">'.esc($label).'</td>'
  .'<td align="right" style="'.$cell.'color:#9ca3af;text-decoration:line-through">'.esc($limit).'</td>'
  .'<td align="right" style="'.$cell.'color:'.MAIL_INK.'">'.esc($current===''||$current===null?'-':$current).'</td>'
  .'<td align="right" style="'.$cell.'color:'.MAIL_ACCENT.';padding-right:0">'.esc($requested).'</td></tr>';
}}
$head=function(string $t,string $align='right'):string{return '<td align="'.$align.'" style="padding:8px 8px 8px 0;font-size:11px;letter-spacing:.3px;text-transform:uppercase;color:'.MAIL_MUTED.';border-bottom:1px solid #d1d5db">'.esc($t).'</td>';};
echo card('Rate Details','<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>'.$head('Item','left').$head('Company rate').$head('Current').$head('Requested').'</tr>'
 .amountRow('Price per shop',$a['limitRate']??'',$a['currentRate']??'',$a['requestedRate']??'')
 .amountRow('Travelling cost per shop',$a['limitFar']??'',$a['currentFar']??'',$a['requestedFar']??'')
 .'</table>','#fff4e6','','#fbd9b5',null,'tag');

replyChoices();
echo '<p style="font-size:11px;line-height:1.6;color:'.MAIL_MUTED.';margin:0 0 16px">APPROVED accepts the requested rate. NOT APPROVED keeps the company rate. Please keep the Request ID in the subject.</p>';
pageEnd('Regards,','Operations Team',$config);
