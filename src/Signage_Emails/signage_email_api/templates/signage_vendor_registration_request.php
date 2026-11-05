<?php require_once __DIR__.'/_common.php';
/* The whole mail is laid out here. The CRM sends only the vendor's data in the payload (vendor.*), the optional note typed on the
   mail screen (bodyHtml) and the files; no text or HTML structure is built by the CRM. */
$v=is_array($data['vendor']??null)?$data['vendor']:[];
$bank=is_array($v['bank']??null)?$v['bank']:[];
$areas=is_array($v['serviceAreas']??null)?implode(', ',array_map('strval',$v['serviceAreas'])):'';
$gst=trim((string)($v['gstin']??''));
if($gst===''&&array_key_exists('hasGst',$v)&&$v['hasGst']===false)$gst='Not registered for GST';
$bankLine=implode(' / ',array_filter([$bank['accountName']??'',$bank['accountNo']??'',$bank['ifsc']??''],static fn($x)=>trim((string)$x)!==''));
$contact=implode(', ',array_filter([$v['contactPerson']??'',$v['designation']??''],static fn($x)=>trim((string)$x)!==''));
$place=implode(', ',array_filter([$v['address']??'',$v['district']??'',$v['state']??'',$v['pincode']??''],static fn($x)=>trim((string)$x)!==''));

pageStart('New Vendor Registration Request','Please register the vendor below in Zoho Books and reply to this mail with the Vendor ID.',$config);
chips($data,'Vendor Registration');

echo '<p style="font-size:13px;line-height:1.7;color:#243857;margin:0 0 12px">Hi Team,<br>Please register the new vendor below in <strong>Zoho Books</strong> and reply to this mail with the <strong>Vendor ID</strong>.</p>';

echo card('Vendor',rowsHtml([
 ['building','Vendor / Firm',$v['vendorName']??''],
 ['tag','Vendor Type',$v['vendorType']??''],
 ['key','Vendor Code (CRM)',$v['vendorCode']??''],
 ['person','Contact Person',$contact],
 ['phone','Mobile',$v['mobile']??''],
 ['mail','Email',$v['email']??''],
 ['pin','Address',$place],
 ['briefcase','Service Area',$areas],
]),'#f6f0ff','#7c3aed','#e4d6fb');

echo card('Tax & Bank Details',rowsHtml([
 ['pan','PAN',$v['pan']??''],
 ['gst','GST',$gst],
 ['key','Aadhaar',$v['aadhaar']??''],
 ['folder','Bank (Name / Account / IFSC)',$bankLine],
]),'#eef6ff','#2563eb','#cfe2fb');

/* Optional note written on the CRM mail screen (cleaned to simple tags by index_signage.php). */
if(!empty($data['bodyHtml']))echo '<div style="font-size:13px;line-height:1.7;color:#243857;margin:0 0 14px;padding:10px 14px;background:#f8fafd;border-left:3px solid #7c3aed;border-radius:4px"><div style="font-size:11px;color:#6a7890;margin-bottom:4px"><strong>Note from the Operations Team</strong></div>'.$data['bodyHtml'].'</div>';

attachmentsCard($data,'Attachments (KYC Documents)','#f6f0ff','#7c3aed','PAN, GST, Aadhaar, cancelled cheque and any other document uploaded for this vendor.');
noteBar('Please reply to this mail with the Vendor ID once the vendor is created. The Operations Team will enter it in the CRM and continue the KYC check.');
pageEnd('Regards,','Operations Team',$config);
