<?php
declare(strict_types=1);
use PHPMailer\PHPMailer\PHPMailer;
if(is_file(__DIR__.'/vendor/autoload.php')){require_once __DIR__.'/vendor/autoload.php';}
else{foreach(['Exception','PHPMailer','SMTP'] as $f)require_once __DIR__.'/PHPMailer/'.$f.'.php';}
$config=require __DIR__.'/config.php';
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
function respond(int $code,array $data):void {http_response_code($code);echo json_encode($data,JSON_UNESCAPED_SLASHES);exit;}
function emails($value):array {
 if(is_string($value)) $value=explode(',',$value);
 if(!is_array($value)) throw new InvalidArgumentException('Recipient list must be an array or comma-separated string');
 $result=[];
 foreach($value as $email){if(!is_string($email)||!filter_var(trim($email),FILTER_VALIDATE_EMAIL))throw new InvalidArgumentException('Invalid email address');$result[]=trim($email);}
 return array_values(array_unique($result));
}
function clean($value):string{return is_scalar($value)?trim((string)$value):'';}
/* Rich text from the CRM mail screen: keep simple formatting tags only and drop every attribute (no scripts, styles or links). */
function safeHtml($value):string{
 $h=is_string($value)?$value:'';
 $h=preg_replace('#<(script|style|iframe|object|embed|svg|math)\b[\s\S]*?</\1\s*>#i','',$h);
 $h=strip_tags($h,'<p><br><strong><b><em><i><u><ul><ol><li><h3><h4><div><span>');
 $h=preg_replace('#<(/?)([a-z0-9]+)\b[^>]*>#i','<$1$2>',$h);
 return function_exists('mb_substr')?mb_substr($h,0,50000):substr($h,0,50000);
}
function renderTemplate(string $path,array $data,array $config):string {ob_start();try{include $path;return (string)ob_get_clean();}catch(Throwable $e){ob_end_clean();throw $e;}}
if($_SERVER['REQUEST_METHOD']!=='POST')respond(405,['status'=>'error','message'=>'POST required']);
if(!$config['api_key'])respond(503,['status'=>'error','message'=>'Server API key is not configured']);
$key=$_SERVER['HTTP_X_API_KEY']??'';
if($key===''&&function_exists('getallheaders')){foreach(getallheaders() as $h=>$v){if(strtolower($h)==='x-api-key'){$key=$v;break;}}}
if(!is_string($key)||!hash_equals($config['api_key'],$key))respond(401,['status'=>'error','message'=>'Unauthorized']);
if(strlen((string)($_SERVER['CONTENT_LENGTH']??0))>20)respond(413,['status'=>'error','message'=>'Request too large']);
if((int)($_SERVER['CONTENT_LENGTH']??0)>18*1024*1024)respond(413,['status'=>'error','message'=>'Request too large']);
try{
 $data=json_decode(file_get_contents('php://input'),true,64,JSON_THROW_ON_ERROR);
 if(!is_array($data))throw new InvalidArgumentException('JSON object required');
 /* Big files: the CRM sends each file in small pieces first (action "stage", under 1 MB per request so a small web-server limit never refuses it), then the mail refers to them by uploadId. */
 if(clean($data['action']??'')==='stage'){
  $uid=clean($data['uploadId']??'');$idx=(int)($data['index']??-1);$cnt=(int)($data['total']??0);
  if(!preg_match('/^[a-f0-9]{32}$/',$uid)||$idx<0||$cnt<1||$idx>=$cnt||$cnt>40)throw new InvalidArgumentException('Invalid upload piece');
  $piece=base64_decode(clean($data['base64']??''),true);
  if($piece===false||$piece===''||strlen($piece)>900*1024)throw new InvalidArgumentException('Invalid upload piece size');
  $root=sys_get_temp_dir().'/signage_stage';if(!is_dir($root))@mkdir($root,0700,true);
  foreach(glob($root.'/*',GLOB_ONLYDIR)?:[] as $old){if(filemtime($old)<time()-7200){array_map('unlink',glob($old.'/*')?:[]);@rmdir($old);}}
  $dir=$root.'/'.$uid;if(!is_dir($dir)&&!@mkdir($dir,0700))throw new RuntimeException('Cannot stage upload');
  if(file_put_contents($dir.'/'.$idx.'.part',$piece)===false)throw new RuntimeException('Cannot stage upload');
  respond(200,['status'=>'success','message'=>'Piece stored','index'=>$idx]);
 }
 $type=clean($data['mailtype']??'');
 $templates=['combined'=>'signage_client_&_project_code_requests.php','client'=>'signage_client_code_request.php','project'=>'signage_project_code_request.php','vendor'=>'signage_vendor_registration_request.php','rateapproval'=>'signage_vendor_rate_approval.php','forgot_mpin'=>'signage_forgot_credential.php','forgot_password'=>'signage_forgot_credential.php'];
 if(!isset($templates[$type]))throw new InvalidArgumentException('Invalid mailtype');
 $isAuth=in_array($type,['forgot_mpin','forgot_password'],true);
 $to=emails($data['toEmail']??[]);$cc=emails($data['ccEmail']??[]);$bcc=emails($data['bccEmail']??[]);
 if(!$to)throw new InvalidArgumentException('toEmail is required');
 if($isAuth){
  if(count($to)!==1||$cc||$bcc)throw new InvalidArgumentException('Exactly one recipient is allowed for this mail type');
  if(!preg_match('/^\d{6}$/',clean($data['code']??'')))throw new InvalidArgumentException('code must be 6 digits');
  $data['expiresInMinutes']=max(1,min(60,(int)($data['expiresInMinutes']??10)));
 }
 $requestId=clean($data['requestId']??'');
 if($requestId===''||strlen($requestId)>100)throw new InvalidArgumentException('Valid requestId required');
 $client=is_array($data['client']??null)?$data['client']:[];
 $project=is_array($data['project']??null)?$data['project']:[];
 if(in_array($type,['combined','client'],true)&&clean($client['clientName']??'')==='')throw new InvalidArgumentException('client.clientName required');
 if(in_array($type,['combined','project'],true)&&clean($project['projectName']??'')==='')throw new InvalidArgumentException('project.projectName required');
 if($type==='project'&&clean($client['clientName']??'')==='')throw new InvalidArgumentException('client.clientName required');
 $vendor=is_array($data['vendor']??null)?$data['vendor']:[];
 if($type==='vendor'&&clean($vendor['vendorName']??'')==='')throw new InvalidArgumentException('vendor.vendorName required');
 $data['bodyHtml']=safeHtml($data['bodyHtml']??'');
 $subject=clean($data['subject']??'');
 if($subject==='')$subject=$isAuth?'Your Signage Verification Code':($type==='rateapproval'?'Vendor Rate Approval Request - '.$requestId:($type==='vendor'?'Vendor Registration Request - '.$requestId:(['combined'=>'Client and Project Code Request','client'=>'Client Code Request','project'=>'Project Code Request'][$type]??'Code Request').' - '.$requestId));
 if(strlen($subject)>200||preg_match('/[\r\n]/',$subject))throw new InvalidArgumentException('Invalid subject');
 $attachments=[];
 foreach(($data['attachments']??[]) as $a){
  if(!is_array($a))throw new InvalidArgumentException('Invalid attachment');
  $name=basename(str_replace('\\','/',clean($a['filename']??'')));
  $ext=strtolower(pathinfo($name,PATHINFO_EXTENSION));
  $allowed=['pdf'=>'application/pdf','xlsx'=>'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','xls'=>'application/vnd.ms-excel','docx'=>'application/vnd.openxmlformats-officedocument.wordprocessingml.document','png'=>'image/png','jpg'=>'image/jpeg','jpeg'=>'image/jpeg','zip'=>'application/zip','doc'=>'application/msword','ppt'=>'application/vnd.ms-powerpoint','pptx'=>'application/vnd.openxmlformats-officedocument.presentationml.presentation','csv'=>'text/csv','txt'=>'text/plain','gif'=>'image/gif','webp'=>'image/webp'];
  if(!$name||!isset($allowed[$ext])||strlen($name)>160)throw new InvalidArgumentException('Unsupported attachment filename');
  if(!empty($a['uploadId'])){
   $uid=clean($a['uploadId']);$cnt=(int)($a['chunks']??0);
   if(!preg_match('/^[a-f0-9]{32}$/',$uid)||$cnt<1||$cnt>40)throw new InvalidArgumentException('Invalid attachment upload');
   $dir=sys_get_temp_dir().'/signage_stage/'.$uid;$binary='';
   for($i=0;$i<$cnt;$i++){$p=@file_get_contents($dir.'/'.$i.'.part');if($p===false)throw new InvalidArgumentException('An uploaded piece is missing. Send the mail again');$binary.=$p;if(strlen($binary)>8*1024*1024)break;}
   array_map('unlink',glob($dir.'/*')?:[]);@rmdir($dir);
  }else{
   $encoded=clean($a['base64']??'');
   if(str_contains($encoded,'base64,'))$encoded=explode('base64,',$encoded,2)[1];
   $binary=base64_decode($encoded,true);
  }
  if($binary===false||strlen($binary)===0||strlen($binary)>8*1024*1024)throw new InvalidArgumentException('Invalid attachment content or size');
  if($ext==='pdf'&&!str_starts_with($binary,'%PDF'))throw new InvalidArgumentException('Invalid PDF');
  if(in_array($ext,['xlsx','docx','pptx','zip'],true)&&!str_starts_with($binary,'PK'))throw new InvalidArgumentException('Invalid ZIP-based file');
  if($ext==='png'&&!str_starts_with($binary,"\x89PNG"))throw new InvalidArgumentException('Invalid PNG');
  if(in_array($ext,['jpg','jpeg'],true)&&!str_starts_with($binary,"\xFF\xD8"))throw new InvalidArgumentException('Invalid JPEG');
  $attachments[]=['filename'=>$name,'binary'=>$binary,'mime'=>$allowed[$ext],'size'=>strlen($binary)];
  if(count($attachments)>8)throw new InvalidArgumentException('Maximum 8 attachments');
 }
 $data['requestId']=$requestId;
 $body=renderTemplate(__DIR__.'/templates/'.$templates[$type],$data,$config);
 $mail=new PHPMailer(true);$mail->isSMTP();$mail->Host=$config['smtp_host'];$mail->Port=$config['smtp_port'];
 $mail->SMTPAuth=$config['smtp_user']!=='';
 if($mail->SMTPAuth){$mail->Username=$config['smtp_user'];$mail->Password=$config['smtp_password'];}
 if($config['smtp_secure']!=='')$mail->SMTPSecure=$config['smtp_secure'];
 $mail->CharSet='UTF-8';$mail->setFrom($config['from_email'],$config['from_name']);
 foreach($to as $email)$mail->addAddress($email);
 foreach($cc as $email)if(!in_array($email,$to,true))$mail->addCC($email);
 foreach($bcc as $email)if(!in_array($email,$to,true)&&!in_array($email,$cc,true))$mail->addBCC($email);
 if(!empty($data['replyTo'])&&filter_var($data['replyTo'],FILTER_VALIDATE_EMAIL))$mail->addReplyTo($data['replyTo']);
 foreach($attachments as $a)$mail->addStringAttachment($a['binary'],$a['filename'],'base64',$a['mime']);
 $mail->isHTML(true);$mail->Subject=$subject;$mail->Body=$body;
 $mail->AltBody=trim(html_entity_decode(strip_tags(preg_replace('/<\/(tr|p|div)>/i',"\n",$body))));
 $mail->send();
 respond(200,['status'=>'success','message'=>'Email accepted by SMTP server','mailtype'=>$type,'requestId'=>$requestId,'to'=>$to,'cc'=>$cc,'attachments'=>array_column($attachments,'filename')]);
}catch(InvalidArgumentException|JsonException $e){respond(422,['status'=>'error','message'=>$e->getMessage()]);}
catch(Throwable $e){error_log('Signage mail error: '.$e->getMessage());respond(500,['status'=>'error','message'=>'Email sending failed. Check server logs.']);}
