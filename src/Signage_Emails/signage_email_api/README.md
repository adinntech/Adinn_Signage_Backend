# Adinn Signage Mail API (Code Creation Requests)

PHP API on cPanel that renders the branded HTML mail and sends it. Three mail types:

| `mailtype` | Mail | Required fields |
|---|---|---|
| `combined` | Client Code & Project Code Request | `requestId`, `toEmail`, `client.clientName`, `project.projectName` |
| `client` | New Client Code Creation Request | `requestId`, `toEmail`, `client.clientName` |
| `project` | New Project Code Creation Request | `requestId`, `toEmail`, `client.clientCode`, `project.projectName` |

## Deploy

Upload this folder to `public_html/adinndigital/api/signage_emails/signage_email_api/` (folder names are case-sensitive).

Files: `index_signage.php`, `config.php`, `config.local.php`, `PHPMailer/`, `templates/`. PHPMailer is bundled in `PHPMailer/`; if a Composer `vendor/` folder exists it is used instead. PHP 8.1+.

**Config.** cPanel cannot set env variables, so secrets go in `config.local.php` (copy `config.local.example.php`; never commit it):

- `SIGNAGE_API_KEY` - required. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- SMTP defaults to the local relay (`localhost:25`, no auth, from `noreply@adinndigital.com`), same as the Roadshow mailer. Optional overrides: `SIGNAGE_SMTP_HOST`, `SIGNAGE_SMTP_PORT`, `SIGNAGE_SMTP_SECURE` (`ssl`/`tls`), `SIGNAGE_SMTP_USER`, `SIGNAGE_SMTP_PASSWORD`, `SIGNAGE_FROM_EMAIL`.

**Backend (Node)** `.env`: `SIGNAGE_MAIL_URL` (the endpoint below) and `SIGNAGE_MAIL_KEY` (same value as `SIGNAGE_API_KEY`). Mailer: `src/modules/codeRequests/signageCodeMail.ts`.

When the key is rotated, update `config.local.php` on the server, `.env.development`, `.env.production`, the live server's env, and Bruno, then restart the Node backend.

Call the API only from the backend or a test client, never from browser or mobile code (the key must stay secret). Use HTTPS.

## Header / footer images

Upload banner images to `templates/images/` (public URL `.../templates/images/<file>`; override the base with `SIGNAGE_ASSET_URL` in `config.local.php`):

The folder is `templates/Images/` (capital I; Linux is case-sensitive).

| File | Used by |
|---|---|
| `Signage_Email_Header.png` | header banner of all three mails (the title is rendered as HTML text below it) |
| `footer.png` | optional footer strip |
| `icons/*.png` | Font Awesome glyphs pre-rendered to PNG (`chip-*.png` for the four summary cards, the rest for detail rows). Icon fonts and web fonts do not work in Gmail/Outlook, so images are used. Upload the whole `icons/` folder. |

Font: Montserrat via Google Fonts link (Apple Mail, iOS Mail, some Outlook); Gmail and others fall back to Segoe UI/Arial. If the header image is missing the mail falls back to an HTML banner. Logo in the sign-off: `https://adinnroadshows.com/images/logo/AdinnLogo.png` (white theme); dark theme logo is `https://adinnoutdoors.com/images/adinnHeaderlogo.svg`.

## Request

```
POST https://adinndigital.com/api/signage_emails/signage_email_api/index_signage.php
Content-Type: application/json
X-API-Key: <SIGNAGE_API_KEY>
```

In Bruno: Headers tab -> `Content-Type` and `X-API-Key` (the header name is `X-API-Key`, not `SIGNAGE_MAIL_KEY`). Body tab -> JSON.

Common fields: `mailtype`, `toEmail` (array or comma-separated), `ccEmail`, `subject` (optional, max 200 chars, no line breaks), `requestId` (max 100 chars), `requestDate`, `source`, `message`, `replyTo`, `attachments`.

### 1. Combined (`mailtype: "combined"`)

```json
{
  "mailtype": "combined",
  "toEmail": ["reactdeveloper@adinn.co.in"],
  "ccEmail": ["smm@adinn.co.in", "2002karthikatg@gmail.com"],
  "subject": "Client & Project Code Request - REQ-2026-0105",
  "requestId": "REQ-2026-0105",
  "requestDate": "30 Oct 2026",
  "source": "Client Servicing Team",
  "message": "Please create both codes and confirm.",
  "client": {
    "clientName": "UltraTech Cement Limited",
    "contactPerson": "Jeeva Dhanalakshmi M",
    "email": "clientservice1@adinn.co.in",
    "phone": "9789056789",
    "gstNumber": "33AAACU5678G1Z2",
    "panNumber": "AAACU5678G",
    "address": "123, Industrial Estate, Guindy, Chennai - 600032"
  },
  "project": {
    "projectName": "CEO Meeting Standee",
    "projectType": "Signage",
    "location": "Chennai",
    "startDate": "22 Aug 2026",
    "endDate": "26 Aug 2026",
    "businessUnit": "Signage Solutions",
    "remarks": "Standee required for CEO meeting"
  },
  "attachments": []
}
```

### 2. Client code only (`mailtype: "client"`)

```json
{
  "mailtype": "client",
  "toEmail": ["reactdeveloper@adinn.co.in"],
  "ccEmail": ["smm@adinn.co.in"],
  "subject": "New Client Code Request - REQ-2026-0106",
  "requestId": "REQ-2026-0106",
  "requestDate": "30 Oct 2026",
  "source": "Client Servicing Team",
  "message": "Please create a new client code and notify Client Servicing once done.",
  "client": {
    "clientName": "UltraTech Cement Limited",
    "contactPerson": "Jeeva Dhanalakshmi M",
    "email": "clientservice1@adinn.co.in",
    "phone": "9789056789",
    "gstNumber": "33AAACU5678G1Z2",
    "panNumber": "AAACU5678G",
    "address": "123, Industrial Estate, Guindy, Chennai - 600032"
  },
  "attachments": []
}
```

### 3. Project code only (`mailtype: "project"`)

`client.clientCode` is required (the client already has a code). `description` is shown in this mail.

```json
{
  "mailtype": "project",
  "toEmail": ["reactdeveloper@adinn.co.in"],
  "ccEmail": ["smm@adinn.co.in"],
  "subject": "New Project Code Request - PCR-2026-0105",
  "requestId": "PCR-2026-0105",
  "requestDate": "30 Oct 2026",
  "source": "Client Servicing Team",
  "message": "Please create the project code for the order below.",
  "client": {
    "clientName": "GM Modular Pvt Ltd",
    "clientCode": "CLI-0018"
  },
  "project": {
    "projectName": "Recce Tirunelveli Lot 2",
    "projectType": "Signage Recce",
    "location": "Tirunelveli",
    "startDate": "25 Oct 2026",
    "endDate": "27 Oct 2026",
    "businessUnit": "Signage Solutions",
    "description": "Site recce for outdoor signage locations and measurement collection.",
    "remarks": "Confirmed project code is used in Create Project and Recce assignment."
  },
  "attachments": []
}
```

### Attachments (optional, any type)

A filename alone does not attach anything; `base64` must hold the real file bytes (a `data:...;base64,` prefix is accepted).

```json
"attachments": [
  { "filename": "GST_Certificate.pdf", "base64": "JVBERi0xLjQK..." }
]
```

Limits: max 8 files, 8 MB each, request max 18 MB. Allowed: PDF, XLS, XLSX, DOCX, PNG, JPG, ZIP. File contents are checked against the extension.

## Responses

| HTTP | Body | Meaning |
|---|---|---|
| 200 | `{"status":"success","message":"Email accepted by SMTP server", ...}` | Accepted by SMTP (not a delivery guarantee) |
| 401 | `Unauthorized` | `X-API-Key` header missing or wrong |
| 405 | `POST required` | Not a POST |
| 413 | `Request too large` | Over 18 MB |
| 422 | validation message (e.g. `client.clientName required`, `Invalid mailtype`, `Invalid email address`) | Fix the payload |
| 500 | `Email sending failed. Check server logs.` | SMTP error; see `error_log` in the folder |
| 503 | `Server API key is not configured` | `config.local.php` missing or has no key |

## Preview templates without sending

Use a private server-side PHP script with `ob_start()` and `include` with sample `$data` and `$config`. Never expose a public unauthenticated mail preview endpoint.
