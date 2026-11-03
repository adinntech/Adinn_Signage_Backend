<?php require_once __DIR__.'/_common.php';
$v=is_array($data['vendor']??null)?$data['vendor']:[];

pageStart('New Vendor Registration Request','Please register the vendor below in Zoho Books and reply to this mail with the Vendor ID.',$config);
chips($data,'Vendor Registration');

echo card('Vendor',rowsHtml([
 ['building','Vendor / Firm',$v['vendorName']??''],
 ['tag','Vendor Type',$v['vendorType']??''],
 ['key','Vendor Code (CRM)',$v['vendorCode']??''],
]),'#f6f0ff','#7c3aed','#e4d6fb');

/* The mail text written in the CRM mail screen (already cleaned by index_signage.php to simple tags). */
if(!empty($data['bodyHtml']))echo '<div style="font-size:13px;line-height:1.7;color:#243857;margin:0 0 14px">'.$data['bodyHtml'].'</div>';

attachmentsCard($data,'Attachments (KYC Documents)','#f6f0ff','#7c3aed','PAN, bank proof, GST and any other document uploaded for this vendor.');
noteBar('Please reply to this mail with the Vendor ID once the vendor is created. The Operations Team will enter it in the CRM and continue the KYC check.');
pageEnd('Regards,','Operations Team',$config);
