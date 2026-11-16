<?php require_once __DIR__.'/_common.php';
$c=is_array($data['client']??null)?$data['client']:[];$p=is_array($data['project']??null)?$data['project']:[];

$hasDetails=is_array($data['details']['sections']??null)&&count($data['details']['sections'])>0;
if($hasDetails){
 $d=$data['details'];
 $line=!empty($d['existing'])
  ?'Please create the project code and estimation code for the order below under Client ID '.(($d['clientId']??'')!==''?$d['clientId']:'-').'.'
  :'This is a new client. Please create the client ID in Zoho, then the project code and estimation code for the order below.';
}else $line='Please create a project code for the following project and share the generated code by replying to this email.';

pageStart('Project Code Creation Request',$line,$config,'folder');
chips($data,'Project Code');
para('Dear Team,');

if($hasDetails){
 detailsCards($data);
}else{
 echo card('Project Details',rowsHtml([
  ['','Client Name',$c['clientName']??''],
  ['','Client Code',($c['clientCode']??'')!==''?$c['clientCode'].' (existing)':''],
  ['','Project Name',$p['projectName']??''],
  ['','Project Type',$p['projectType']??''],
  ['','Location',$p['location']??''],
  ['','Start Date',$p['startDate']??''],
  ['','End Date',$p['endDate']??''],
  ['','Business Unit',$p['businessUnit']??''],
  ['','Description',$p['description']??''],
  ['','Remarks',$p['remarks']??''],
 ]),'#eaf2ff','','#d6e4fa',null,'building');
}

if($hasDetails)noteBlock($data,'Note from '.(($data['source']??'')!==''?$data['source']:'Client Servicing'));
else messageBlock($data);
attachmentsCard($data,'Project Documents');

actionBox('');
pageEnd('Regards,','Client Servicing Team',$config);
