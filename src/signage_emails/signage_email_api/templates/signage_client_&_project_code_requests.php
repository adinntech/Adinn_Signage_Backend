<?php require_once __DIR__.'/_common.php';
$c=is_array($data['client']??null)?$data['client']:[];$p=is_array($data['project']??null)?$data['project']:[];

pageStart('Client and Project Code Request','Please create the client code and the project code for the details below.',$config,'folder');
chips($data,'Client and Project Code');
para('Dear Team,');

echo card('Client Details',rowsHtml([
 ['','Client Name',$c['clientName']??''],['','GST Number',$c['gstNumber']??''],['','PAN Number',$c['panNumber']??''],
 ['','Contact Person',$c['contactPerson']??''],['','Email',$c['email']??''],['','Phone',$c['phone']??''],['','Address',$c['address']??''],
]),'#eaf2ff','','',null,'building');
echo card('Project Details',rowsHtml([
 ['','Project Name',$p['projectName']??''],['','Project Type',$p['projectType']??''],['','Location',$p['location']??''],
 ['','Start Date',$p['startDate']??''],['','End Date',$p['endDate']??''],['','Business Unit',$p['businessUnit']??''],
 ['','Description',$p['description']??''],['','Remarks',$p['remarks']??''],
]),'#e9f8ef','','',null,'folder');

messageBlock($data);
attachmentsCard($data,'Supporting Documents');

actionBox('Reply with "Client Code: ABC123" and "Project Code: 12345678" once created. Keep the Request ID in the subject.','','Please reply to this email with the Client Code and Project Code.');
pageEnd('Regards,','Client Servicing Team',$config);
