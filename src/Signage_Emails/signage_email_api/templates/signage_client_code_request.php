<?php require_once __DIR__.'/_common.php';
$c=is_array($data['client']??null)?$data['client']:[];

pageStart('header_client.png','New Client Code Creation Request','Please create a new client code as per the enclosed onboarding documents.',$config);
chips($data,'Client Code Creation');

$left=[['building','Client Name',$c['clientName']??''],['person','Contact Person',$c['contactPerson']??''],['mail','Email ID',$c['email']??''],['phone','Phone Number',$c['phone']??'']];
$right=[['gst','GST Number',$c['gstNumber']??''],['pan','PAN Number',$c['panNumber']??''],['pin','Address',$c['address']??'']];
echo card('Client Details (For Code Creation)','<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td valign="top" width="50%" style="padding-right:14px">'.rowsHtml($left).'</td><td valign="top" width="50%">'.rowsHtml($right).'</td></tr></table>','#eaf2ff','#1d4ed8','#d6e4fa');

attachmentsCard($data,'Attachments (Client Onboarding)','#e9f8ee','#15803d');
noteBar('The confirmed client code will be used later while creating the project. Please process the client code creation and notify the Client Servicing Team once it is completed.');
messageBlock($data);
pageEnd('Regards,','Client Servicing Team',$config);
