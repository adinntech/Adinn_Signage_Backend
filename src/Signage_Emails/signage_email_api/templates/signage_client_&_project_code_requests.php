<?php require_once __DIR__.'/_common.php';
$c=is_array($data['client']??null)?$data['client']:[];$p=is_array($data['project']??null)?$data['project']:[];
headerMail('Client Code & Project Code Request',$data,$config);
section('01 · Client Code Creation Request',['Client Name'=>$c['clientName']??'','GST Number'=>$c['gstNumber']??'','PAN Number'=>$c['panNumber']??'','Primary Contact'=>$c['contactPerson']??'','Email'=>$c['email']??'','Phone'=>$c['phone']??'','Address'=>$c['address']??'']);
section('02 · Project Code Creation Request',['Project Name'=>$p['projectName']??'','Project Type'=>$p['projectType']??'','Location'=>$p['location']??'','Proposed Start Date'=>$p['startDate']??'','Proposed End Date'=>$p['endDate']??'','Business Unit'=>$p['businessUnit']??'','Remarks'=>$p['remarks']??'','Description'=>$p['description']??''],'#e3273d');
attachmentsMail($data);footerMail($data);
