<?php require_once __DIR__.'/_common.php';
$c=is_array($data['client']??null)?$data['client']:[];$p=is_array($data['project']??null)?$data['project']:[];
headerMail('New Project Code Creation Request',$data,$config);
section('Project Details (For Code Creation)',['Client Name'=>$c['clientName']??'','Client Code'=>$c['clientCode']??'','Project Name'=>$p['projectName']??'','Project Type'=>$p['projectType']??'','Location'=>$p['location']??'','Expected Start Date'=>$p['startDate']??'','Expected End Date'=>$p['endDate']??'','Business Unit'=>$p['businessUnit']??'','Description'=>$p['description']??'','Remarks'=>$p['remarks']??'']);
attachmentsMail($data);footerMail($data);
