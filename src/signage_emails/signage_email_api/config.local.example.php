<?php
// Copy to config.local.php on the server. Do NOT commit config.local.php.
// Default SMTP is the local relay (localhost:25, no auth, from noreply@adinndigital.com), same as the Roadshow mailer.
return [
 'SIGNAGE_API_KEY'=>'PUT_A_LONG_RANDOM_SECRET_HERE',   // e.g. output of: openssl rand -hex 32
 // Only if the local relay is not enough:
 // 'SIGNAGE_SMTP_HOST'=>'mail.adinndigital.com', 'SIGNAGE_SMTP_PORT'=>465, 'SIGNAGE_SMTP_SECURE'=>'ssl',
 // 'SIGNAGE_SMTP_USER'=>'noreply@adinndigital.com', 'SIGNAGE_SMTP_PASSWORD'=>'...',
];
