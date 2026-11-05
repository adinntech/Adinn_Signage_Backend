<?php require_once __DIR__.'/_common.php';
$c=is_array($data['client']??null)?$data['client']:[];$p=is_array($data['project']??null)?$data['project']:[];

pageStart('Client Code & Project Code Request','Please review the details below and create the required client code and project code as per the enclosed documents.',$config);
chips($data,'Client Code & Project Code');

$clientCard=card('Client Code Creation Request',rowsHtml([
 ['building','Client Name',$c['clientName']??''],['gst','GST Number',$c['gstNumber']??''],['pan','PAN Number',$c['panNumber']??''],
 ['person','Primary Contact',$c['contactPerson']??''],['mail','Email',$c['email']??''],['phone','Phone',$c['phone']??''],['pin','Address',$c['address']??''],
]),'#eaf2ff','#1d4ed8','#d6e4fa','1');
$projectCard=card('Project Code Creation Request',rowsHtml([
 ['folder','Project Name',$p['projectName']??''],['tag','Project Type',$p['projectType']??''],['pin','Location',$p['location']??''],
 ['date','Proposed Start Date',$p['startDate']??''],['date','Proposed End Date',$p['endDate']??''],['briefcase','Business Unit',$p['businessUnit']??''],
 ['desc','Description',$p['description']??''],['note','Remarks',$p['remarks']??''],
]),'#fdecee','#e11d48','#f6cdd2','2');
echo '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td valign="top" width="50%" style="padding-right:7px">'.$clientCard.'</td><td valign="top" width="50%" style="padding-left:7px">'.$projectCard.'</td></tr></table>';

echo '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e1e9f5;border-radius:9px;margin:0 0 14px"><tr><td style="padding:11px 14px;font-size:14px;font-weight:bold;color:#10244a">&#10148; Send Mode<div style="font-size:11px;font-weight:normal;color:#6a7890;margin-top:2px">Select how you would like to send this request.</div></td></tr><tr><td style="padding:0 14px 12px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td width="50%" valign="top" style="padding-right:6px"><div style="border:1px solid #2563eb;background:#eef5ff;border-radius:8px;padding:9px 12px;font-size:12px;color:#10244a"><strong>&#9673; Same Mail (Combined Request)</strong><div style="font-size:10px;color:#6a7890;margin-top:3px">Send client code and project code request together in a single mail.</div></div></td><td width="50%" valign="top" style="padding-left:6px"><div style="border:1px solid #e1e9f5;border-radius:8px;padding:9px 12px;font-size:12px;color:#6a7890"><strong>&#9675; Separate Mail</strong><div style="font-size:10px;margin-top:3px">Send client code request and project code request in separate mails.</div></div></td></tr></table></td></tr></table>';

attachmentsCard($data,'Attachments','#eaf2ff','#1d4ed8','Please find the supporting documents attached.');
noteBar('The confirmed Client Code and Project Code will be used later in the Create Project process.');
messageBlock($data);
pageEnd('Regards,','Client Servicing Team',$config);
