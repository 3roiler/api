import express, { Application, Request, Response, NextFunction } from 'express';
import limiter from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import { config, logger, system, error, bootstrap } from './services';
import routes from './routes';
import cors from 'cors';

const app: Application = express();

app.set('trust proxy', 1);
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors({
  origin: config.corsOrigin,
  credentials: true
}));

/**
 * Global 100 req / 10 min per-IP limit. The metrics router owns its own,
 * more generous limiter — the live dashboard auto-refreshes across 7
 * endpoints and would otherwise chew through this bucket in ~7 min,
 * knocking everything else (profile, blog, settings) offline for the
 * same IP. `skip` keeps those two scopes independent.
 */
app.use(limiter({
  windowMs: 600000,
  max: 100,
  skip: (req) => req.path.startsWith(`${config.prefix}/admin/metrics/`)
}));

app.use(logger);
app.use(config.prefix, routes);
app.use((req: Request, res: Response, next: NextFunction) => {
  next(error.notFound(`Route ${req.originalUrl} not found`));
});
app.use(system.errorHandler);

app.listen(config.port, () => {
  console.log(`
  ╔════════════════════════════════════════╗
  ║   Production: ${config.isProduction.toString().padEnd(23)}║
  ║   Port: ${config.port.toString().padEnd(30)}║
  ║   API Prefix: ${config.prefix.padEnd(24)}║
  ╚════════════════════════════════════════╝
  `);

  // Best-effort: seed admin permissions for configured ADMIN_EMAILS. Runs
  // async after listen(); a failure logs but does not crash the server.
  bootstrap.seedAdminPermissions().catch(err => {
    console.error('[bootstrap] seedAdminPermissions failed:', err);
  });
});

process.on('unhandledRejection', (err: Error) => {
  console.error('UNHANDLED REJECTION! 💥 Shutting down...');
  console.error(err.name, err.message);
  process.exit(1);
});

export default app;
