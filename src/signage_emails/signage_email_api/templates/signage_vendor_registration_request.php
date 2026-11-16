<?php require_once __DIR__.'/_common.php';
/* Vendor registration request. The CRM sends the vendor's data (vendor.*), the optional note typed on the mail screen
   (bodyHtml) and the files; the whole layout is built here. */
$v=is_array($data['vendor']??null)?$data['vendor']:[];
$bank=is_array($v['bank']??null)?$v['bank']:[];
$areas=is_array($v['serviceAreas']??null)?implode(', ',array_map('strval',$v['serviceAreas'])):'';
$gst=trim((string)($v['gstin']??''));
if($gst===''&&array_key_exists('hasGst',$v)&&$v['hasGst']===false)$gst='Not registered for GST';
$bankLine=implode(' / ',array_filter([$bank['accountName']??'',$bank['accountNo']??'',$bank['ifsc']??''],static fn($x)=>trim((string)$x)!==''));
$contact=implode(', ',array_filter([$v['contactPerson']??'',$v['designation']??''],static fn($x)=>trim((string)$x)!==''));
$place=implode(', ',array_filter([$v['address']??'',$v['district']??'',$v['state']??'',$v['pincode']??''],static fn($x)=>trim((string)$x)!==''));

pageStart('Vendor Registration Request','Please register the following vendor in Zoho Books / ERP.',$config,'building');
chips($data,'Vendor Registration');

para('Dear Accounts Team,');

echo card('Vendor Information',rowsHtml([
 ['','Vendor / Firm',$v['vendorName']??''],
 ['','Vendor Type',$v['vendorType']??''],
 ['','CRM Code',$v['vendorCode']??''],
 ['','Contact Person',$contact],
 ['','Mobile',$v['mobile']??''],
 ['','Email',$v['email']??''],
 ['','Address',$place],
 ['','Service Area',$areas],
]),'#eef1fb','','#e4d6fb',null,'person');

echo card('Tax and Bank Details',rowsHtml([
 ['','PAN',$v['pan']??''],
 ['','GST',$gst],
 ['','Aadhaar',$v['aadhaar']??''],
 ['','Bank (Name / Account / IFSC)',$bankLine],
]),'#eef6ff','','#cfe2fb',null,'pan');

noteBlock($data,'Note from Operations');
attachmentsCard($data,'KYC Documents');

actionBox('Reply with the Vendor Registration ID (5 digits or more), for example "Vendor ID: 12345", once the vendor is created. Keep the Request ID in the subject.','Reply with Vendor ID');
pageEnd('Regards,','Operations Team',$config);
