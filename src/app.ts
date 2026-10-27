import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import { env } from './config/env';
import { errorHandler, notFoundHandler } from './common/http';
import { authRouter } from './modules/auth/auth.routes';
import { clientRouter } from './modules/clients/client.routes';
import { zohoRouter } from './modules/zoho/zoho.routes';
import { projectRouter } from './modules/projects/project.routes';
import { communicationRouter } from './modules/communications/communication.routes';
import { userRouter } from './modules/users/user.routes';
import { siteRouter } from './modules/sites/site.routes';
import { boardRouter } from './modules/boards/boardOption.routes';
import { costRouter } from './modules/costing/costing.routes';
import { expenseRouter } from './modules/expenses/expense.routes';
import { vendorRouter } from './modules/vendors/vendor.routes';
import { vendorJobsRouter } from './modules/vendor-jobs/vendorJobs.routes';
import { allocationRouter } from './modules/allocation/allocation.routes';
import { notificationRouter } from './modules/notifications/notification.routes';
import { fileRouter } from './modules/files/file.routes';
import { salesRouter } from './modules/sales/sales.routes';
import { templateRouter } from './modules/templates/template.routes';
import { rateItemRouter } from './modules/ratecards/rateItem.routes';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet());
  const isLocalhostOrigin = (origin: string) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  app.use(
    cors({
      credentials: true,
      origin: (origin, cb) =>
        cb(
          null,
          !origin ||
            env.corsOrigins.includes(origin) ||
            (!env.isProd && isLocalhostOrigin(origin)),
        ),
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  if (env.NODE_ENV !== 'test') app.use(morgan('tiny'));

  app.get('/api/v1/health', (_req, res) => res.json({ success: true, data: { status: 'ok' } }));
  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/clients', clientRouter);
  app.use('/api/v1/zoho', zohoRouter);
  app.use('/api/v1/projects', projectRouter);
  app.use('/api/v1/communications', communicationRouter);
  app.use('/api/v1/users', userRouter);
  app.use('/api/v1/notifications', notificationRouter);
  app.use('/api/v1/sales', salesRouter);
  app.use('/api/v1/email-templates', templateRouter);
  app.use('/api/v1/rate-items', rateItemRouter);
  app.use('/api/v1', siteRouter);
  app.use('/api/v1', boardRouter);
  app.use('/api/v1', costRouter);
  app.use('/api/v1', expenseRouter);
  app.use('/api/v1/vendors', vendorRouter);
  app.use('/api/v1/vendor', vendorJobsRouter);
  app.use('/api/v1', allocationRouter);
  app.use('/api/v1', fileRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}


