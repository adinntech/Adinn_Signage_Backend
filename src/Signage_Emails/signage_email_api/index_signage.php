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
 $type=clean($data['mailtype']??'');
 $templates=['combined'=>'signage_client_&_project_code_requests.php','client'=>'signage_client_code_request.php','project'=>'signage_project_code_request.php'];
 if(!isset($templates[$type]))throw new InvalidArgumentException('Invalid mailtype');
 $to=emails($data['toEmail']??[]);$cc=emails($data['ccEmail']??[]);$bcc=emails($data['bccEmail']??[]);
 if(!$to)throw new InvalidArgumentException('toEmail is required');
 $requestId=clean($data['requestId']??'');
 if($requestId===''||strlen($requestId)>100)throw new InvalidArgumentException('Valid requestId required');
 $client=is_array($data['client']??null)?$data['client']:[];
 $project=is_array($data['project']??null)?$data['project']:[];
 if(in_array($type,['combined','client'],true)&&clean($client['clientName']??'')==='')throw new InvalidArgumentException('client.clientName required');
 if(in_array($type,['combined','project'],true)&&clean($project['projectName']??'')==='')throw new InvalidArgumentException('project.projectName required');
 if($type==='project'&&clean($client['clientName']??'')==='')throw new InvalidArgumentException('client.clientName required');
 $subject=clean($data['subject']??'');
 if($subject==='')$subject=ucfirst($type).' Signage Code Request - '.$requestId;
 if(strlen($subject)>200||preg_match('/[\r\n]/',$subject))throw new InvalidArgumentException('Invalid subject');
 $attachments=[];
 foreach(($data['attachments']??[]) as $a){
  if(!is_array($a))throw new InvalidArgumentException('Invalid attachment');
  $name=basename(str_replace('\\','/',clean($a['filename']??'')));
  $ext=strtolower(pathinfo($name,PATHINFO_EXTENSION));
  $allowed=['pdf'=>'application/pdf','xlsx'=>'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','xls'=>'application/vnd.ms-excel','docx'=>'application/vnd.openxmlformats-officedocument.wordprocessingml.document','png'=>'image/png','jpg'=>'image/jpeg','jpeg'=>'image/jpeg','zip'=>'application/zip'];
  if(!$name||!isset($allowed[$ext])||strlen($name)>160)throw new InvalidArgumentException('Unsupported attachment filename');
  $encoded=clean($a['base64']??'');
  if(str_contains($encoded,'base64,'))$encoded=explode('base64,',$encoded,2)[1];
  $binary=base64_decode($encoded,true);
  if($binary===false||strlen($binary)===0||strlen($binary)>8*1024*1024)throw new InvalidArgumentException('Invalid attachment content or size');
  if($ext==='pdf'&&!str_starts_with($binary,'%PDF'))throw new InvalidArgumentException('Invalid PDF');
  if(in_array($ext,['xlsx','docx','zip'],true)&&!str_starts_with($binary,'PK'))throw new InvalidArgumentException('Invalid ZIP-based file');
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
