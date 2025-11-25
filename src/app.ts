import express, { Application, Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import { config, logger, system, error } from './services';
import routes from './routes';

const app: Application = express();

app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(logger);
app.use((req: Request, res: Response, next) => {
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Origin', '*');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }

  next();
});

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
});

process.on('unhandledRejection', (err: Error) => {
  console.error('UNHANDLED REJECTION! 💥 Shutting down...');
  console.error(err.name, err.message);
  process.exit(1);
});

export default app;