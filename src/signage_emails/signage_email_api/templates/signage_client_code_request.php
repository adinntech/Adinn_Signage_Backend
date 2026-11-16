<?php require_once __DIR__.'/_common.php';
$c=is_array($data['client']??null)?$data['client']:[];

pageStart('Client Code Creation Request','Please create a client code for the client below.',$config,'building');
chips($data,'Client Code');
para('Dear Team,');

echo card('Client Details',rowsHtml([
 ['','Client Name',$c['clientName']??''],
 ['','Contact Person',$c['contactPerson']??''],
 ['','Email',$c['email']??''],
 ['','Phone',$c['phone']??''],
 ['','GST Number',$c['gstNumber']??''],
 ['','PAN Number',$c['panNumber']??''],
 ['','Address',$c['address']??''],
]),'#eaf2ff','','',null,'building');

messageBlock($data);
attachmentsCard($data,'Onboarding Documents');

actionBox('Reply with the code as "Client Code: ABC123". Keep the Request ID in the subject.','','Please reply to this email with the Client Code.');
pageEnd('Regards,','Client Servicing Team',$config);
