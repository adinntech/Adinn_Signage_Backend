import { postSignageMail } from '../codeRequests/signageCodeMail';

/** Mail types handled by signage_email_api (templates/signage_forgot_credential.php). */
export type AuthMailType = 'forgot_mpin' | 'forgot_password';

export interface AuthMail {
  mailType: AuthMailType;
  to: string;
  name: string;
  code: string;
  expiresInMinutes: number;
  /** Reference shown in the mail so the user can quote it to support. */
  requestId: string;
}

export const AUTH_MAIL_SUBJECT: Record<AuthMailType, string> = {
  forgot_mpin: 'Reset your Signage MPIN',
  forgot_password: 'Reset your Signage password',
};

export const sendAuthMail = (m: AuthMail) =>
  postSignageMail({
    mailtype: m.mailType,
    toEmail: [m.to],
    subject: AUTH_MAIL_SUBJECT[m.mailType],
    requestId: m.requestId,
    userName: m.name,
    code: m.code,
    expiresInMinutes: m.expiresInMinutes,
  });
