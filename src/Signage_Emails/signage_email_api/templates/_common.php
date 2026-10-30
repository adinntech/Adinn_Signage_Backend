<?php
/* Shared building blocks for the three signage code-request mails (table-based, inline CSS, email-client safe).
   Header/footer banners are optional images in templates/images/ (header_combined.png, header_client.png,
   header_project.png, footer.png). When a file is missing, an HTML fallback is rendered instead. */

function esc($v):string{return htmlspecialchars(is_scalar($v)?(string)$v:'',ENT_QUOTES|ENT_SUBSTITUTE,'UTF-8');}
function asset(array $config,string $file):string{return rtrim($config['asset_url'],'/').'/'.$file;}
function hasAsset(string $file):bool{return is_file(__DIR__.'/images/'.$file);}

/* Emoji icons as numeric entities so the file encoding can never garble them. */
const ICON=['id'=>'&#35;&#65039;&#8419;','date'=>'&#128197;','type'=>'&#129513;','source'=>'&#128228;','building'=>'&#127970;','gst'=>'&#129534;','pan'=>'&#128179;','person'=>'&#128100;','mail'=>'&#9993;&#65039;','phone'=>'&#128222;','pin'=>'&#128205;','folder'=>'&#128193;','tag'=>'&#127991;&#65039;','briefcase'=>'&#128188;','note'=>'&#128172;','desc'=>'&#128221;','key'=>'&#128273;','clip'=>'&#128206;','info'=>'&#8505;&#65039;'];

function fileSizeText(array $a):string{
 $raw=(string)($a['base64']??'');
 $at=strpos($raw,'base64,');if($at!==false)$raw=substr($raw,$at+7);
 $b=(int)(strlen($raw)*3/4);
 return $b>=1048576?round($b/1048576,1).' MB':max(1,(int)round($b/1024)).' KB';
}
function fileBadge(string $name):array{
 $e=strtolower(pathinfo($name,PATHINFO_EXTENSION));
 return match($e){'pdf'=>['PDF','#e11d48'],'xls','xlsx'=>['XLS','#16a34a'],'doc','docx'=>['DOC','#2563eb'],'zip'=>['ZIP','#2563eb'],'png','jpg','jpeg'=>['IMG','#f59e0b'],default=>['FILE','#64748b']};
}

function pageStart(string $img,string $title,string $subtitle,array $config):void{
 echo '<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'.esc($title).'</title></head>';
 echo '<body style="margin:0;padding:0;background:#eef2f8;font-family:\'Segoe UI\',Arial,Helvetica,sans-serif;color:#14294d">';
 echo '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef2f8"><tr><td align="center" style="padding:20px 8px">';
 echo '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:700px;background:#ffffff;border:1px solid #dfe7f3;border-radius:10px;overflow:hidden">';
 if(hasAsset($img)){
  echo '<tr><td style="padding:0;line-height:0;font-size:0"><img src="'.esc(asset($config,$img)).'" alt="'.esc($title).'" width="700" style="display:block;width:100%;max-width:700px;height:auto;border:0"></td></tr>';
 }else{
  echo '<tr><td style="padding:28px 30px;background:#10244a;border-bottom:4px solid #ed2435"><div style="font-size:12px;letter-spacing:2px;color:#9fb3d9;font-weight:bold">ADINN &middot; SIGNAGE SOLUTIONS</div><div style="font-size:28px;line-height:1.2;font-weight:800;color:#ffffff;margin:10px 0 8px">'.esc($title).'</div><div style="font-size:13px;line-height:1.6;color:#c9d6ee">'.esc($subtitle).'</div></td></tr>';
 }
 echo '<tr><td style="padding:18px 22px 6px">';
}

/* Four summary cards: Request ID, Date, Type, Source. */
function chips(array $data,string $typeLabel):void{
 $cells=[['id','Request ID',$data['requestId']??'','#fde8ea','#e11d48'],['date','Request Date',$data['requestDate']??date('d M Y'),'#e6f7ef','#16a34a'],['type','Request Type',$typeLabel,'#efeafd','#7c3aed'],['source','Request Source',$data['source']??'Client Servicing Team','#e6f6f1','#0f9d78']];
 echo '<table role="presentation" width="100%" cellpadding="0" cellspacing="6" style="margin:0 -6px 8px;width:calc(100% + 12px)"><tr>';
 foreach($cells as [$ic,$label,$val,$bg,$fg]){
  echo '<td width="25%" valign="top" style="background:#f4f8fd;border:1px solid #e1e9f5;border-radius:8px;padding:10px"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td valign="middle" style="width:30px"><div style="width:28px;height:28px;line-height:28px;text-align:center;border-radius:7px;background:'.$bg.';color:'.$fg.';font-size:14px">'.ICON[$ic].'</div></td><td valign="middle" style="padding-left:8px"><div style="font-size:10px;color:#6a7890">'.esc($label).'</div><div style="font-size:12px;font-weight:700;color:#10244a;word-break:break-word">'.esc($val).'</div></td></tr></table></td>';
 }
 echo '</tr></table>';
}

/* [icon, label, value] rows; empty values are skipped. */
function rowsHtml(array $rows):string{
 $o='<table role="presentation" width="100%" cellpadding="0" cellspacing="0">';
 foreach($rows as [$ic,$label,$val]){
  if($val===null||trim((string)$val)==='')continue;
  $o.='<tr><td valign="top" width="24" style="padding:7px 0;border-bottom:1px solid #edf1f7;font-size:13px">'.ICON[$ic].'</td><td valign="top" width="36%" style="padding:7px 6px;border-bottom:1px solid #edf1f7;font-size:12px;color:#6a7890">'.esc($label).'</td><td valign="top" style="padding:7px 0;border-bottom:1px solid #edf1f7;font-size:12px;font-weight:700;color:#10244a;word-break:break-word">'.nl2br(esc($val)).'</td></tr>';
 }
 return $o.'</table>';
}

/* A bordered card with a coloured title bar. $num shows a numbered circle (combined mail). */
function card(string $title,string $bodyHtml,string $headBg,string $accent,string $border,?string $num=null):string{
 $badge=$num!==null?'<span style="display:inline-block;width:22px;height:22px;line-height:22px;text-align:center;border-radius:11px;background:'.$accent.';color:#fff;font-size:12px;font-weight:bold;margin-right:8px">'.esc($num).'</span>':'';
 return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid '.$border.';border-radius:9px;overflow:hidden;margin:0 0 14px"><tr><td style="padding:11px 14px;background:'.$headBg.';color:'.$accent.';font-size:15px;font-weight:bold">'.$badge.esc($title).'</td></tr><tr><td style="padding:6px 14px 10px;background:#ffffff">'.$bodyHtml.'</td></tr></table>';
}

function attachmentsCard(array $data,string $title,string $headBg,string $accent,string $hint=''):void{
 $items=is_array($data['attachments']??null)?$data['attachments']:[];
 if(!$items)return;
 $b='';
 if($hint!=='')$b.='<div style="font-size:11px;color:#6a7890;margin:2px 0 8px">'.esc($hint).'</div>';
 foreach($items as $a){
  $name=basename(str_replace('\\','/',(string)($a['filename']??'Document')));
  [$tag,$col]=fileBadge($name);
  $b.='<div style="display:inline-block;vertical-align:top;width:47%;min-width:200px;margin:0 1.5% 8px 0;border:1px solid #e1e9f5;border-radius:8px;padding:8px 10px;box-sizing:border-box"><span style="display:inline-block;background:'.$col.';color:#fff;font-size:9px;font-weight:bold;border-radius:3px;padding:2px 5px;margin-right:6px">'.$tag.'</span><span style="font-size:11px;font-weight:700;color:#10244a;word-break:break-word">'.esc($name).'</span><div style="font-size:10px;color:#6a7890;margin-top:3px">'.esc(fileSizeText($a)).'</div></div>';
 }
 echo card($title,$b,$headBg,$accent,'#e1e9f5');
}

function noteBar(string $text):void{
 echo '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 12px"><tr><td style="background:#eaf3ff;border:1px solid #cfe2fb;border-radius:8px;padding:11px 14px;font-size:12px;line-height:1.6;color:#1d4f91"><strong>'.ICON['info'].'</strong>&nbsp; '.esc($text).'</td></tr></table>';
}

function messageBlock(array $data):void{
 if(!empty($data['message']))echo '<p style="font-size:12px;line-height:1.7;color:#394d6b;margin:0 0 10px"><strong>Additional Notes:</strong> '.nl2br(esc($data['message'])).'</p>';
}

/* Sign-off, logo and (optional) footer banner; closes the document. */
function pageEnd(string $greeting,string $team,array $config):void{
 echo '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:6px"><tr><td valign="bottom" style="font-size:12px;line-height:1.7;color:#4a5b74;padding:6px 0 14px">'.esc($greeting).'<br><strong style="color:#10244a">'.esc($team).'</strong><br>Adinn Advertising Services Ltd.</td>';
 echo '<td align="right" valign="bottom" style="padding:6px 0 14px"><img src="'.esc($config['logo_url']).'" alt="Adinn" height="38" style="height:38px;width:auto;border:0;display:inline-block"><div style="font-size:12px;color:#ed2435;font-style:italic;font-weight:bold;margin-top:4px">Ideas into Visible Impact</div></td></tr></table>';
 echo '</td></tr>';
 if(hasAsset('footer.png'))echo '<tr><td style="padding:0;line-height:0;font-size:0;border-top:1px solid #e7edf4"><img src="'.esc(asset($config,'footer.png')).'" alt="Adinn Advertising Services Ltd." width="700" style="display:block;width:100%;max-width:700px;height:auto;border:0"></td></tr>';
 echo '</table></td></tr></table></body></html>';
}
