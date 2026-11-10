<?php require_once __DIR__.'/_common.php';
$c=is_array($data['client']??null)?$data['client']:[];$p=is_array($data['project']??null)?$data['project']:[];

pageStart('New Project Code Creation Request',"Please raise the project code as per the client's requirement and enclosed project documents.",$config);
chips($data,'Project Code Creation');

$hasDetails=is_array($data['details']['sections']??null)&&count($data['details']['sections'])>0;
if($hasDetails){
 $d=$data['details'];
 $line=!empty($d['existing'])
  ?'Kindly create the project code and estimation code for the order below under Client ID '.(($d['clientId']??'')!==''?$d['clientId']:'-').'.'
  :'This is a new client. Kindly create the client ID in Zoho for this client, and the project code and estimation code for the order below.';
 echo '<p style="font-size:13px;line-height:1.7;color:#243857;margin:0 0 12px">'.esc($line).'</p>';
 detailsCards($data);
}else
echo card('Project Details (For Code Creation)',rowsHtml([
 ['building','Client Name',$c['clientName']??''],
 ['key','Client Code',($c['clientCode']??'')!==''?$c['clientCode'].' (Existing)':''],
 ['folder','Project Name',$p['projectName']??''],
 ['tag','Project Type',$p['projectType']??''],
 ['pin','Location',$p['location']??''],
 ['date','Expected Start Date',$p['startDate']??''],
 ['date','Expected End Date',$p['endDate']??''],
 ['briefcase','Business Unit',$p['businessUnit']??''],
 ['desc','Description',$p['description']??''],
 ['note','Remarks',$p['remarks']??''],
]),'#eaf2ff','#1d4ed8','#d6e4fa');

attachmentsCard($data,'Attachments (Project Requirement)','#fdecee','#e11d48');
noteBar('The confirmed project code will be used in Create Project and Recce assignment workflows.');
if($hasDetails)noteBlock($data,'Note from the '.(($data['source']??'')!==''?$data['source']:'Client Servicing Team'));
else messageBlock($data);
pageEnd('Thanks & Regards,','Recce Coordination / Client Servicing Team',$config);
