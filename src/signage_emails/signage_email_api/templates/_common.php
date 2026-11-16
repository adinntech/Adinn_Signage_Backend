<?php
/* Shared building blocks for the signage mails. Table-based, inline CSS (safe in Gmail / Outlook / Apple Mail).
   Design: full-width banner image, title + one-line subtitle, four summary tiles, rounded cards with a coloured title bar
   and fields laid out side by side (3 per line, each with a small icon), file chips, a light info bar, logo sign-off.
   Fonts are light (400/500; only the title and card headings are 600). Banner and icons are PNGs on the web server
   (config asset_url -> templates/Images/ and icons/); icon fonts do not work in Gmail/Outlook, so icons are images. */

function esc($v):string{return htmlspecialchars(is_scalar($v)?(string)$v:'',ENT_QUOTES|ENT_SUBSTITUTE,'UTF-8');}

const MAIL_FONT="'Montserrat','Segoe UI',Arial,Helvetica,sans-serif";
const MAIL_INK='#243857';     /* values and body text */
const MAIL_MUTED='#6a7890';   /* labels and hints */
const MAIL_LINE='#e1e9f5';    /* hairlines */
const MAIL_ACCENT='#ed2435';  /* Adinn red */
const MAIL_NAVY='#10244a';    /* titles */

/* Small PNG icon from templates/Images/icons/ (prefix 'chip-' for the summary tile icons). */
function ic(string $k,int $w=16,string $prefix=''):string{return '<img src="'.esc(rtrim($GLOBALS['signage_asset']??'','/').'/icons/'.$prefix.$k.'.png').'" width="'.$w.'" height="'.$w.'" alt="" style="display:block;border:0;width:'.$w.'px;height:'.$w.'px">';}

/* "2026-11-13T04:10:00Z" -> "13 Nov 2026"; anything that is not an ISO date is shown as sent. */
function mailDate($v):string{
 $s=trim((string)$v);
 if($s===''||!preg_match('/^\d{4}-\d{2}-\d{2}/',$s))return $s===''?date('d M Y'):$s;
 $t=strtotime($s);return $t?date('d M Y',$t):$s;
}

function fileSizeText(array $a):string{
 $raw=(string)($a['base64']??'');
 $at=strpos($raw,'base64,');if($at!==false)$raw=substr($raw,$at+7);
 $b=isset($a['size'])?(int)$a['size']:(int)(strlen($raw)*3/4);
 return $b>=1048576?round($b/1048576,1).' MB':max(1,(int)round($b/1024)).' KB';
}
function fileBadge(string $name):array{
 $e=strtolower(pathinfo($name,PATHINFO_EXTENSION));
 return match($e){'pdf'=>['PDF','#e11d48'],'xls','xlsx'=>['XLS','#16a34a'],'doc','docx'=>['DOC','#2563eb'],'zip'=>['ZIP','#2563eb'],'png','jpg','jpeg','webp','gif'=>['IMG','#f59e0b'],default=>['FILE','#64748b']};
}

/* Opens the document: banner image, then the title and an optional one-line subtitle. ($icon is accepted for older calls; not shown.) */
function pageStart(string $title,string $subtitle,array $config,string $icon=''):void{
 $f=MAIL_FONT;$GLOBALS['signage_asset']=$config['asset_url']??'';
 $banner=rtrim($config['asset_url']??'','/').'/Signage_Email_Header.png';
 echo '<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600&display=swap" rel="stylesheet"><title>'.esc($title).'</title></head>';
 echo '<body style="margin:0;padding:0;background:#eef2f8;font-family:'.$f.';color:'.MAIL_INK.'">';
 echo '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef2f8"><tr><td align="center" style="padding:20px 8px">';
 echo '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:700px;background:#ffffff;border:1px solid #dfe7f3;border-radius:10px;overflow:hidden">';
 echo '<tr><td style="padding:0;line-height:0;font-size:0"><img src="'.esc($banner).'" alt="Adinn Signage Solutions" width="700" style="display:block;width:100%;max-width:700px;height:auto;border:0"></td></tr>';
 echo '<tr><td style="background:'.MAIL_NAVY.';padding:11px 24px;font-family:'.$f.'"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="font-size:12px;font-weight:600;letter-spacing:.6px;color:#ffffff">&#9881;&nbsp; SYSTEM GENERATED EMAIL</td><td align="right" style="font-size:11.5px;font-weight:400;color:#d6e0f5">ADINN CRM &nbsp;|&nbsp; Operations Workflow</td></tr></table></td></tr>';
 echo '<tr><td style="padding:22px 24px 6px;font-family:'.$f.'"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px"><tr><td width="54" valign="middle"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td align="center" valign="middle" style="width:48px;height:48px;background:#fdecee;border:1px solid #f8cdd3;border-radius:11px">'.ic($icon!==''?$icon:'note',24).'</td></tr></table></td>';
 echo '<td valign="middle" style="padding-left:14px;border-left:2px solid '.MAIL_ACCENT.'"><div style="font-size:21px;line-height:1.3;font-weight:600;letter-spacing:-.2px;color:'.MAIL_NAVY.';padding-left:12px">'.esc($title).'</div>';
 if($subtitle!=='')echo '<div style="font-size:13px;font-weight:400;line-height:1.6;color:'.MAIL_MUTED.';padding:3px 0 0 12px">'.esc($subtitle).'</div>';
 echo '</td></tr></table>';
}

/* Four summary tiles: Request ID, Date, Type, Requested by. */
function chips(array $data,string $typeLabel):void{
 $cells=[['id','Request ID',$data['requestId']??''],['date','Request Date',mailDate($data['requestDate']??'')],['type','Request Type',$typeLabel],['source','Requested By',$data['source']??'Operations Team']];
 echo '<table role="presentation" width="100%" cellpadding="0" cellspacing="6" style="margin:0 -6px 10px;width:calc(100% + 12px)"><tr>';
 foreach($cells as [$ic,$label,$val]){
  echo '<td width="25%" valign="top" style="background:#f4f8fd;border:1px solid #e1e9f5;border-radius:8px;padding:10px"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td valign="middle" style="width:30px">'.ic($ic,28,'chip-').'</td><td valign="middle" style="padding-left:8px"><div style="font-size:10px;font-weight:400;color:'.MAIL_MUTED.'">'.esc($label).'</div><div style="font-size:12px;font-weight:500;color:'.MAIL_NAVY.';word-break:break-word">'.esc($val).'</div></td></tr></table></td>';
 }
 echo '</tr></table>';
}

/* Paragraph of body text. */
function para(string $html):void{echo '<p style="font-size:13px;font-weight:400;line-height:1.7;color:'.MAIL_INK.';margin:0 0 12px">'.$html.'</p>';}

/* Icon for a row, picked from its label (when the caller gives no icon). */
function rowIcon(string $label):string{
 $l=strtolower($label);
 foreach([['mobile','phone'],['phone','phone'],['email','mail'],['gst','gst'],['pan','pan'],['aadhaar','key'],['bank','folder'],['address','pin'],['location','pin'],['area','pin'],['date','date'],['type','tag'],['contact','person'],['entered','person'],['code','key'],['order','folder'],['project','folder'],['scope','desc'],['description','desc'],['remarks','note']] as [$k,$i])if(strpos($l,$k)!==false)return $i;
 if(preg_match('/\bid\b/',$l))return 'key';
 if(preg_match('/client|vendor|firm|company/',$l))return 'building';
 return 'desc';
}
function rowCell(array $it,int $span,int $pct,bool $divider):string{
 return '<td colspan="'.$span.'" width="'.$pct.'%" valign="top" style="padding:10px;border-bottom:1px solid #edf1f7;'.($divider?'border-left:1px solid #edf1f7;':'').'"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td valign="top" style="width:24px;padding-top:2px">'.ic($it[0],16).'</td><td valign="top" style="padding-left:4px"><div style="font-size:11px;font-weight:400;color:'.MAIL_MUTED.'">'.esc($it[1]).'</div><div style="font-size:12.5px;font-weight:500;color:'.MAIL_NAVY.';line-height:1.5;word-break:break-word">'.nl2br(esc($it[2])).'</div></td></tr></table></td>';
}
/* [icon, label, value] rows laid out side by side, 3 per line, each with an icon. Long values (address, scope, notes)
   take a full line. An empty icon slot picks the icon from the label; empty values are skipped. */
function rowsHtml(array $rows,int $cols=3):string{
 $items=[];
 foreach($rows as $r){
  $label=(string)($r[1]??'');$val=$r[2]??'';
  if($val===null||trim((string)$val)==='')continue;
  $items[]=[(string)($r[0]??'')!==''?(string)$r[0]:rowIcon($label),$label,(string)$val];
 }
 $pct=(int)floor(100/$cols);$o='<table role="presentation" width="100%" cellpadding="0" cellspacing="0">';$buf=[];
 $flush=function()use(&$buf,&$o,$cols,$pct){
  if(!$buf)return;
  $o.='<tr>';foreach($buf as $i=>$it)$o.=rowCell($it,1,$pct,$i>0);
  for($i=count($buf);$i<$cols;$i++)$o.='<td width="'.$pct.'%" style="border-bottom:1px solid #edf1f7;border-left:1px solid #edf1f7">&nbsp;</td>';
  $o.='</tr>';$buf=[];
 };
 foreach($items as $it){
  if(strlen($it[2])>34||strpos($it[2],"\n")!==false){$flush();$o.='<tr>'.rowCell($it,$cols,100,false).'</tr>';}
  else{$buf[]=$it;if(count($buf)===$cols)$flush();}
 }
 $flush();
 return $o.'</table>';
}

/* A rounded card with a coloured title bar. Colours default to a rotating blue / green / purple / orange; the accent
   follows the bar colour when not given. $num and $icon are accepted for older calls. */
function card(string $title,string $bodyHtml,string $headBg='',string $accent='',string $border='',?string $num=null,?string $icon=null):string{
 static $n=0;
 $themes=[['#eaf2ff','#1d4ed8','#d6e4fa'],['#e9f8ef','#16a34a','#cfeedb'],['#f6f0ff','#7c3aed','#e3d5fb'],['#fff4e5','#d97706','#fbe3bf'],['#fdecee','#e11d48','#f8cdd3']];
 $by=['#eef1fb'=>2,'#f6f0ff'=>2,'#eef6ff'=>0,'#eaf2ff'=>0,'#e9f8ef'=>1,'#fff4e6'=>3,'#fff4e5'=>3,'#fdecee'=>4];
 if($headBg==='')[$headBg,$a,$b]=$themes[$n++%count($themes)];
 else[,$a,$b]=$themes[$by[$headBg]??0];
 $accent=$accent!==''?$accent:$a;$border=$border!==''?$border:$b;
 return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid '.$border.';border-radius:9px;overflow:hidden;margin:0 0 14px"><tr><td style="padding:11px 14px;background:'.$headBg.'"><table role="presentation" cellpadding="0" cellspacing="0"><tr>'.($icon!==null?'<td width="26" valign="middle">'.ic($icon,18).'</td>':'').'<td valign="middle" style="color:'.$accent.';font-size:13px;font-weight:600;letter-spacing:.2px">'.esc($title).'</td></tr></table></td></tr><tr><td style="padding:2px 6px 6px;background:#ffffff">'.$bodyHtml.'</td></tr></table>';
}

/* Attached files as small chips: coloured type badge, name, size (and the label the CRM gave it). */
function attachmentsCard(array $data,string $title,string $headBg='',string $accent='',string $hint=''):void{
 $items=is_array($data['attachments']??null)?$data['attachments']:[];
 if(!$items)return;
 $b='<div style="padding:8px 8px 2px">';
 if($hint!=='')$b.='<div style="font-size:11px;color:'.MAIL_MUTED.';margin:0 0 8px">'.esc($hint).'</div>';
 foreach($items as $a){
  $name=basename(str_replace('\\','/',(string)($a['filename']??'Document')));
  [$tag,$col]=fileBadge($name);
  $b.='<div style="display:inline-block;vertical-align:top;width:47%;min-width:200px;margin:0 1.5% 8px 0;border:1px solid #e1e9f5;border-radius:8px;padding:8px 10px;box-sizing:border-box"><span style="display:inline-block;background:'.$col.';color:#fff;font-size:9px;font-weight:600;border-radius:3px;padding:2px 5px;margin-right:6px">'.$tag.'</span><span style="font-size:11px;font-weight:500;color:'.MAIL_NAVY.';word-break:break-word">'.esc($name).'</span><div style="font-size:10px;color:'.MAIL_MUTED.';margin-top:3px">'.esc(fileSizeText($a)).(!empty($a['label'])?' &middot; '.esc($a['label']):'').'</div></div>';
 }
 echo card($title,$b.'</div>',$headBg!==''?$headBg:'#fdecee',$accent);
}

/* The reply instruction: light blue info bar. $title (optional) is a short semi-bold line above the text;
   $button is a small visual cue of the reply asked for (not a link). */
function actionBox(string $text,string $button='',string $title='Action Required'):void{
 $head=$title!==''?'<div style="font-size:13px;font-weight:600;color:#1d4f91;margin:0 0 2px">'.esc($title).'</div>':'';
 $btn=$button!==''?'<td align="right" valign="middle" style="padding:0 14px 0 0"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:'.MAIL_NAVY.';color:#ffffff;font-size:12px;font-weight:500;border-radius:6px;padding:9px 14px;white-space:nowrap">&#8617;&nbsp; '.esc($button).'</td></tr></table></td>':'';
 echo '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 12px;background:#eaf3ff;border:1px solid #cfe2fb;border-radius:8px"><tr><td width="28" valign="top" style="padding:13px 0 13px 14px">'.ic('info',16).'</td><td valign="middle" style="padding:11px 14px 11px 8px;font-size:12px;font-weight:400;line-height:1.6;color:#1d4f91">'.$head.esc($text).'</td>'.$btn.'</tr></table>';
}
function noteBar(string $text):void{actionBox($text,'','Please note');}

/* Two reply choices for the approval mail. */
function replyChoices(string $text='Please reply to this email with exactly one of the following:'):void{
 echo '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 10px;background:#fdf5f6;border:1px solid #f8cdd3;border-radius:9px"><tr><td style="padding:14px 16px"><div style="font-size:12.5px;font-weight:500;color:'.MAIL_NAVY.';margin:0 0 10px">'.esc($text).'</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>'
  .'<td width="49%" align="center" style="background:#e6f7ee;border:1px solid #b6e5c9;border-radius:8px;padding:11px;font-size:14px;font-weight:600;color:#15803d">&#10004;&nbsp; APPROVED</td><td width="2%">&nbsp;</td>'
  .'<td width="49%" align="center" style="background:#fdeaec;border:1px solid #f5b8c0;border-radius:8px;padding:11px;font-size:14px;font-weight:600;color:#be123c">&#10006;&nbsp; NOT APPROVED</td>'
  .'</tr></table></td></tr></table>';
}

function messageBlock(array $data):void{
 /* bodyHtml is cleaned by index_signage.php (simple formatting tags only); the plain message is the fallback. */
 if(!empty($data['bodyHtml']))echo card('Additional Notes','<div style="font-size:13px;line-height:1.7;color:'.MAIL_INK.';padding:8px 8px 4px">'.$data['bodyHtml'].'</div>');
 elseif(!empty($data['message']))echo card('Additional Notes','<div style="font-size:13px;line-height:1.7;color:'.MAIL_INK.';padding:8px 8px 4px">'.nl2br(esc($data['message'])).'</div>');
}

/* Data-only details sent by the CRM: details.sections = [{title, rows:[{label,value}], table:{columns:[..], rows:[[..]]}}]. One card each. */
function detailsCards(array $data):void{
 $d=is_array($data['details']??null)?$data['details']:[];
 $sections=is_array($d['sections']??null)?$d['sections']:[];
 foreach($sections as $s){
  if(!is_array($s))continue;
  $title=trim((string)($s['title']??''));$rows=is_array($s['rows']??null)?$s['rows']:[];$t=is_array($s['table']??null)?$s['table']:null;
  $body='';
  if($rows){$list=[];foreach($rows as $r){if(is_array($r))$list[]=['',(string)($r['label']??''),(string)($r['value']??'')];}$body.=rowsHtml($list);}
  if($t&&is_array($t['columns']??null)&&is_array($t['rows']??null)){
   $body.='<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr>';
   foreach($t['columns'] as $c)$body.='<td style="padding:8px 10px;background:#f3f6fb;border-bottom:1px solid #dfe6f1;font-size:10.5px;font-weight:500;color:#4a5b74;text-transform:uppercase;letter-spacing:.3px">'.esc($c).'</td>';
   $body.='</tr>';
   foreach($t['rows'] as $r){if(!is_array($r))continue;$body.='<tr>';foreach($r as $cell)$body.='<td valign="top" style="padding:8px 10px;border-bottom:1px solid #edf1f7;font-size:12.5px;font-weight:500;color:'.MAIL_NAVY.';word-break:break-word">'.esc($cell).'</td>';$body.='</tr>';}
   $body.='</table>';
  }
  if($body===''||$title==='')continue;
  echo card($title,$body);
 }
}

/* Optional note written on the CRM mail screen (cleaned to simple tags by index_signage.php); only sent when the person changed the default text. */
function noteBlock(array $data,string $title):void{
 if(empty($data['bodyHtml']))return;
 echo '<div style="font-size:13px;line-height:1.7;color:'.MAIL_INK.';margin:0 0 14px;padding:10px 14px;background:#f8fafd;border-left:3px solid #7c3aed;border-radius:4px"><div style="font-size:11px;color:'.MAIL_MUTED.';margin-bottom:4px">'.esc($title).'</div>'.$data['bodyHtml'].'</div>';
}

/* Sign-off, logo and tagline; closes the document. */
function pageEnd(string $greeting,string $team,array $config):void{
 echo '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:6px;border-top:1px solid #dfe7f3"><tr><td valign="bottom" style="font-size:12px;font-weight:400;line-height:1.7;color:#4a5b74;padding:14px 0 14px">'.esc($greeting).'<br><strong style="font-weight:600;color:'.MAIL_NAVY.'">'.esc($team).'</strong><br>Adinn Advertising Services Ltd.</td>';
 echo '<td align="right" valign="bottom" style="padding:6px 0 14px"><img src="'.esc($config['logo_url']).'" alt="Adinn" height="38" style="height:38px;width:auto;border:0;display:inline-block"><div style="font-size:12px;color:'.MAIL_ACCENT.';font-style:italic;font-weight:500;margin-top:4px">Ideas into Visible Impact</div></td></tr></table>';
 echo '</td></tr>';
 echo '<tr><td style="padding:0;line-height:0;font-size:0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td width="70%" height="6" style="background:'.MAIL_NAVY.';height:6px;font-size:0;line-height:0">&nbsp;</td><td width="30%" height="6" style="background:'.MAIL_ACCENT.';height:6px;font-size:0;line-height:0">&nbsp;</td></tr></table></td></tr>';
 echo '</table></td></tr></table></body></html>';
}
