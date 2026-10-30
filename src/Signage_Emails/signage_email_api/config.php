<?php
// cPanel shared hosting usually has no way to set server env variables,
// so secrets live in config.local.php (never committed, upload manually).
// Env variables are still honoured as a fallback.
$local = is_file(__DIR__.'/config.local.php') ? require __DIR__.'/config.local.php' : [];
$env = static fn(string $name, $default='') => $local[$name] ?? (getenv($name) ?: $default);

return [
 'api_key'=>(string)$env('SIGNAGE_API_KEY'),
 'smtp_host'=>(string)$env('SIGNAGE_SMTP_HOST','localhost'),
 'smtp_port'=>(int)$env('SIGNAGE_SMTP_PORT',25),
 'smtp_user'=>(string)$env('SIGNAGE_SMTP_USER'),
 'smtp_password'=>(string)$env('SIGNAGE_SMTP_PASSWORD'),
 'smtp_secure'=>(string)$env('SIGNAGE_SMTP_SECURE'),
 'from_email'=>(string)$env('SIGNAGE_FROM_EMAIL','noreply@adinndigital.com'),
 'from_name'=>'Adinn Advertising Services Ltd.',
 // White-theme logo (mail body is white). Dark-theme logo: https://adinnoutdoors.com/images/adinnHeaderlogo.svg
 'logo_url'=>'https://adinnroadshows.com/images/logo/AdinnLogo.png',
 // Optional banner images uploaded to templates/Images/ (Signage_Email_Header.png, footer.png).
 'asset_url'=>(string)$env('SIGNAGE_ASSET_URL','https://adinndigital.com/api/signage_emails/signage_email_api/templates/Images/'),
];
