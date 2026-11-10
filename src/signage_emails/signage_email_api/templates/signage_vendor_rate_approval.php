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

echo card('Amount per shop',rowsHtml([
 ['tag','Requested price per shop',$a['requestedRate']??''],
 ['tag','Requested travelling cost',$a['requestedFar']??''],
 ['tag','Company rate per shop',$a['limitRate']??''],
 ['tag','Company travelling cost',$a['limitFar']??''],
 ['tag','Current price per shop',$a['currentRate']??''],
 ['tag','Current travelling cost',$a['currentFar']??''],
]),'#fff4e6','#f97316','#fbd9b5');

noteBar('Reply APPROVED to accept the requested amount. Reply NOT APPROVED (or REJECTED) and the company rate is applied instead. Please keep the Request ID in the subject.');
pageEnd('Regards,','Operations Team',$config);
