<?php require_once __DIR__.'/_common.php';
$c=is_array($data['client']??null)?$data['client']:[];
headerMail('New Client Code Creation Request',$data,$config);
section('Client Details (For Code Creation)',['Client Name'=>$c['clientName']??'','Contact Person'=>$c['contactPerson']??'','Email ID'=>$c['email']??'','Phone Number'=>$c['phone']??'','GST Number'=>$c['gstNumber']??'','PAN Number'=>$c['panNumber']??'','Address'=>$c['address']??'']);
attachmentsMail($data);footerMail($data);
